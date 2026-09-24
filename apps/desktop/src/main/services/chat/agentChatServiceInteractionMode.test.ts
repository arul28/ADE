import {
  AgentChatEventEnvelope,
  PendingInputRequest,
  buildCodingAgentSystemPrompt,
  codexComputerUseClientCandidates,
  createAgentChatService,
  createDynamicOpenCodeModelDescriptor,
  createService,
  cursorModelsListMock,
  fs,
  installRealTranscriptParser,
  mapPermissionToCodex,
  mockState,
  path,
  probeOpenCodeProviderInventory,
  query,
  readPersistedChatState,
  replaceDynamicOpenCodeModelDescriptors,
  spawn,
  startup,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  waitForEvent,
  waitForFakeTimerCondition,
  waitForFakeTimers,
  writeTestTranscriptEnvelopes,
} from "./agentChatServiceTestFixture";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("interaction mode", () => {
    /**
     * Drive a Codex session to the state this group keeps asserting on: a plan
     * approval card raised by a turn that has since completed, so `activeTurnId`
     * is already null while the card is still waiting on the user.
     */
    const stageCompletedCodexPlanApproval = async () => {
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
        text: "Plan the fix before coding.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-approval",
            type: "plan",
            text: "<proposed_plan>Inspect the lifecycle and patch it.</proposed_plan>",
          },
        },
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });
      // The postcondition every caller relies on: the turn is over and the card
      // is still waiting on the user.
      expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
      expect(readPersistedChatState(session.id).steeringInput).toBeUndefined();
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        awaitingInput: true,
      });
      await expect(service.getSessionSummary(session.id)).resolves.not.toMatchObject({
        steeringInput: true,
      });
      return { service, session, events, approvalEvent };
    };

    it("delivers the status mechanics to a project chat, and not the board rule", async () => {
      // The note/ask mechanics ride the shared ADE guidance block, so every
      // provider gets them. The board rule deliberately does NOT: that block is
      // emitted whole inside the Cursor SDK prompt's hard 3 KB budget, which
      // already sits at ~100% and truncates from the END, so a line here cost
      // that prompt its subagent routing contract and its project rules. The
      // rule lives in the ade-cli-control-plane skill instead.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      await service.sendMessage({ sessionId: session.id, text: "first" }, { awaitDispatch: true });
      await vi.waitFor(() => { expect(mockState.droidPromptCalls.length).toBe(1); });
      const first = JSON.stringify(mockState.droidPromptCalls[0]);

      // Droid's SDK takes no system prompt, so ADE prepends the whole harness
      // prompt to every turn. That harness carries the shared ADE guidance —
      // the note/ask mechanics included — which is why this asserts the harness
      // was built for this turn rather than reading the block out of the
      // payload: `buildCodingAgentSystemPrompt` is mocked to a sentinel here.
      expect(vi.mocked(buildCodingAgentSystemPrompt)).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: "droid-sdk" }),
      );
      expect(first).toContain("system prompt");

      // And the per-turn prefix must NOT carry a second copy. It used to, so
      // every Droid turn paid for the ADE block twice.
      expect(first.split("ade chat note").length - 1).toBeLessThanOrEqual(1);
      expect(first).not.toContain("Work board is derived");
      expect(first).not.toContain("Work-board column is derived");
    });

    it("still delivers the status mechanics per turn to a provider whose harness is not resent", async () => {
      // Cursor has no persistent instruction channel AND no per-turn harness,
      // so for it the lane guidance is the only delivery path — the Droid
      // dedupe must not reach it.
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2.5",
        modelId: "cursor/composer-2.5",
      });

      await service.sendMessage({ sessionId: session.id, text: "first" }, { awaitDispatch: true });
      await vi.waitFor(() => { expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(0); });
      const first = JSON.stringify(mockState.cursorSdkSendCalls[0]);
      expect(first).toContain("ade chat note");
      expect(first).toContain("ade chat ask");
    });

    it("keeps a durable marker for a plan card the user already answered", async () => {
      // Answering a plan approval stages the follow-up and DELIBERATELY withholds
      // the `pending_input_resolved` receipt until the planning turn idles, so
      // the user watches it finish before the implementation turn starts. A
      // crash inside that window used to leave the transcript saying the card
      // was never answered — and the runtime that could answer it is gone, so
      // the restarted chat read "Needs you" with no way to clear it. This marker
      // is what stands in for the receipt until the receipt exists.
      const events: AgentChatEventEnvelope[] = [];
      const { service, laneService, sessionService } = createService({
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
        text: "Plan the fix before coding.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-approval",
            type: "plan",
            text: "<proposed_plan>Inspect the lifecycle and patch it.</proposed_plan>",
          },
        },
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );

      // Answer it while the planning turn is STILL running, so the follow-up
      // stays staged and no receipt is written.
      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });
      expect(events.filter((event) => event.event.type === "pending_input_resolved")).toHaveLength(0);
      // The row is still persisted as blocked — which is exactly why the marker
      // has to exist: nothing else on disk says the user already decided.
      expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
      expect(readPersistedChatState(session.id).answeredPlanApprovalItemIds)
        .toContain(approvalEvent.event.itemId);

      // A second service over the same persisted state is the restart: it must
      // rehydrate the marker rather than drop it on its first write.
      const restarted = createService({ laneService, sessionService });
      await restarted.service.updateSession({ sessionId: session.id, title: "Renamed after restart" });
      expect(readPersistedChatState(session.id).answeredPlanApprovalItemIds)
        .toContain(approvalEvent.event.itemId);
      await restarted.service.disposeAll();

      // Once the planning turn idles the follow-up drains, the REAL receipt is
      // written, and the stand-in must go — leaving it would suppress a later
      // card that happened to reuse the id.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "pending_input_resolved"
          && (event.event as { itemId: string }).itemId === approvalEvent.event.itemId)).toBe(true);
      });
      await vi.waitFor(() => {
        expect(readPersistedChatState(session.id).answeredPlanApprovalItemIds ?? [])
          .not.toContain(approvalEvent.event.itemId);
      });
    });

    it("includes runtime Codex approvals in getTurnStatus ask fields", async () => {
      const { service, session } = await stageCompletedCodexPlanApproval();
      const status = await service.getTurnStatus(session.id);
      expect(status?.phase).toBe("blocked");
      expect(status?.ask?.title).toBeTruthy();
      expect(status?.ask?.title).not.toBe("awaiting input");
    });

    it("defaults interaction mode to null or undefined", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.interactionMode == null).toBe(true);
    });

    it("persists plan interaction mode for Claude sessions via claudePermissionMode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      // Plan interaction mode is derived from claudePermissionMode for Claude sessions
      expect(session.interactionMode).toBe("plan");
      expect(session.permissionMode).toBe("plan");
    });

    it("maps claude plan permission mode to interaction mode plan", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      expect(session.interactionMode).toBe("plan");
      expect(session.claudePermissionMode).toBe("default");
    });

    it("sends Codex plan collaboration mode on turn start for plan sessions", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let readSessionSummary: ((sessionId: string) => Promise<unknown>) | null = null;
      let summaryReadAtClear: Promise<unknown> | null = null;
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
          if (
            event.event.type === "session_meta_updated"
            && event.event.codexEffectiveCollaborationMode === null
            && readSessionSummary
          ) {
            summaryReadAtClear = readSessionSummary(event.sessionId);
          }
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });
      expect(session.permissionMode).toBe("plan");
      readSessionSummary = (sessionId) => service.getSessionSummary(sessionId);

      await service.sendMessage({
        sessionId: session.id,
        text: "Ask one planning question before coding.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "collaborationMode/list")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const threadParams = threadStartRequest?.params as { developerInstructions?: unknown } | undefined;
      const params = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown; networkAccess?: unknown; access?: { type?: unknown } };
        effort?: unknown;
        input?: Array<{ type?: unknown; text?: unknown }>;
        collaborationMode?: Record<string, unknown>;
      } | undefined;
      const collaborationMode = params?.collaborationMode as
        | { mode?: unknown; settings?: { model?: unknown; reasoning_effort?: unknown; developer_instructions?: unknown } }
        | undefined;
      const textInputs = (params?.input ?? []).filter((item) => item.type === "text");

      expect(threadParams?.developerInstructions).toBe("system prompt");
      expect(params?.approvalPolicy).toBe("untrusted");
      expect(params?.sandboxPolicy?.type).toBe("readOnly");
      expect(params?.effort).toBe("medium");
      expect(collaborationMode?.mode).toBe("plan");
      expect(collaborationMode?.settings?.model).toBe("gpt-5.4");
      expect(collaborationMode?.settings?.reasoning_effort).toBe("medium");
      expect(collaborationMode?.settings?.developer_instructions).toBeNull();
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.codexEffectiveCollaborationMode).toBe("plan");
      });
      expect((await service.getSessionSummary(session.id))?.codexEffectiveCollaborationModeWasCleared)
        .toBeUndefined();
      expect(events.some(({ event }) =>
        event.type === "session_meta_updated" && event.codexEffectiveCollaborationMode === null,
      )).toBe(true);
      expect(events.some(({ event }) =>
        event.type === "session_meta_updated" && event.codexEffectiveCollaborationMode === "plan",
      )).toBe(true);
      const clearedSummary = summaryReadAtClear;
      if (!clearedSummary) throw new Error("Expected a summary read while Codex mode was cleared");
      expect(await clearedSummary).toMatchObject({
        codexEffectiveCollaborationModeWasCleared: true,
      });
      expect(textInputs).toHaveLength(1);
      expect(textInputs.at(-1)?.text).toContain("User request:");
      expect(textInputs.at(-1)?.text).toContain("Ask one planning question before coding.");
      expect(textInputs.at(-1)?.text).not.toContain("System context (ADE runtime guidance");
      expect(vi.mocked(buildCodingAgentSystemPrompt)).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: expect.stringContaining(path.basename(tmpRoot)),
          mode: "planning",
          permissionMode: "plan",
          interactive: true,
          runtime: "codex-app-server",
        }),
      );

    });

    it("turns native Codex plan items into an implementation approval request", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "config-toml") return null;
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
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
        text: "Plan the fix before coding.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-1",
            type: "plan",
            text: "<proposed_plan>\n## Summary\n- Inspect the app-server wiring.\n- Patch the native plan handoff.\n</proposed_plan>",
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-1"
          && (event.event.streamingText ?? "").includes("Inspect the app-server wiring"),
      );
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );
      const request = (approvalEvent.event.detail as { request?: { description?: string } } | undefined)?.request;

      expect(request?.description).toContain("## Summary");
      expect(request?.description).toContain("Patch the native plan handoff");
      expect(request?.description).not.toContain("<proposed_plan>");

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      const turnStartCountBeforeApproval = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length;
      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length)
          .toBeGreaterThan(turnStartCountBeforeApproval);
      });
      // An approved plan hands the session straight to full access — the user
      // already reviewed exactly what will happen.
      expect((await service.getSessionSummary(session.id))?.permissionMode).toBe("full-auto");
    });

    it("dismisses a completed Codex plan approval without staging a revision turn", async () => {
      const { service, session, events, approvalEvent } = await stageCompletedCodexPlanApproval();
      expect(readPersistedChatState(session.id).awaitingInput).toBe(true);

      const turnStartsBeforeDismiss = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      await service.dismissPendingInputForSettlement({ sessionId: session.id });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start"))
        .toHaveLength(turnStartsBeforeDismiss);
      expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
      await expect(service.getSessionSummary(session.id)).resolves.not.toMatchObject({
        awaitingInput: true,
      });
      expect(events).toContainEqual(expect.objectContaining({
        sessionId: session.id,
        event: expect.objectContaining({
          type: "pending_input_resolved",
          itemId: approvalEvent.event.itemId,
          resolution: "cancelled",
        }),
      }));
      // Settlement interrupts first and then settles as a net, and both paths
      // resolve Codex cards. One receipt per card, not one per path.
      expect(events.filter((envelope) =>
        envelope.event.type === "pending_input_resolved"
        && envelope.event.itemId === approvalEvent.event.itemId)).toHaveLength(1);
    });

    it("does not start an implementation turn from a plan response staged before settlement", async () => {
      // Answering a plan approval mid-turn stages the follow-up until the turn
      // idles. Settlement has to take those staged responses before it stops
      // the turn: a `turn/completed` landing during the interrupt would
      // otherwise drain one and start a fresh turn on the settled session.
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
        text: "Plan the fix before coding.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-staged-1",
            type: "plan",
            text: "<proposed_plan>Stage this response while the turn runs.</proposed_plan>",
          },
        },
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );

      // The turn is still active, so this response is staged rather than sent.
      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });
      const turnStartsBeforeSettle = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;

      // Hold the interrupt open so the app-server's `turn/completed` lands
      // while the settle is mid-flight — the exact window the staged response
      // used to survive into.
      mockState.delayedCodexMethods.add("turn/interrupt");
      const settling = service.dismissPendingInputForSettlement({ sessionId: session.id });
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockState.flushCodexResponses();
      await settling;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start"))
        .toHaveLength(turnStartsBeforeSettle);
      // The staged response is not silently dropped either: it gets the same
      // cancel receipt as the card it came from.
      expect(events).toContainEqual(expect.objectContaining({
        sessionId: session.id,
        event: expect.objectContaining({
          type: "pending_input_resolved",
          itemId: approvalEvent.event.itemId,
          resolution: "cancelled",
        }),
      }));
      expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
    });

    it("stops a Codex chat whose only pending card is a plan approval from the completed turn", async () => {
      // A Codex plan approval is raised after `turn/completed` has already
      // nulled `activeTurnId`, so Stop takes the no-active-turn path. That path
      // used to return without settling anything, leaving the card rendered and
      // every later send refused by the pending-input guard.
      const { service, session, events, approvalEvent } = await stageCompletedCodexPlanApproval();
      expect(readPersistedChatState(session.id).awaitingInput).toBe(true);

      await service.interrupt({ sessionId: session.id });

      expect(events).toContainEqual(expect.objectContaining({
        sessionId: session.id,
        event: expect.objectContaining({
          type: "pending_input_resolved",
          itemId: approvalEvent.event.itemId,
          resolution: "cancelled",
        }),
      }));
      expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
      // The send gate reads the same state: the next message must reach Codex
      // rather than bounce off a card for a turn that already ended.
      const turnStartsBeforeSend = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      await service.sendMessage({
        sessionId: session.id,
        text: "Different approach, please.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length)
          .toBeGreaterThan(turnStartsBeforeSend);
      });
    });

    it("leaves a Codex plan approval alone when settle teardown stops the session", async () => {
      // `stop_only` stops the work without discarding what the user still owns.
      // A card nobody has answered is the user's to answer, so an automatic
      // settle teardown must not cancel it out from under them.
      const { service, session, events, approvalEvent } = await stageCompletedCodexPlanApproval();

      await service.interrupt({ sessionId: session.id, mode: "stop_only" });

      expect(events.filter((envelope) =>
        envelope.event.type === "pending_input_resolved"
        && envelope.event.itemId === approvalEvent.event.itemId)).toHaveLength(0);
      expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
    });

    it("writes one receipt when stopping a plan approval whose response is already staged", async () => {
      // Answering a plan approval mid-turn stages the follow-up but leaves the
      // approval entry in place, so the item sits in both stores at once. Stop
      // does not run settlement's de-duplication, so the helper has to be the
      // thing that keeps it to one durable receipt.
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
        text: "Plan the fix before coding.",
      }, { awaitDispatch: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-staged-receipt-1",
            type: "plan",
            text: "<proposed_plan>Answer this while the turn still runs.</proposed_plan>",
          },
        },
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );

      // Still mid-turn, so the response is staged rather than dispatched.
      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });

      await service.interrupt({ sessionId: session.id });

      expect(events.filter((envelope) =>
        envelope.event.type === "pending_input_resolved"
        && envelope.event.itemId === approvalEvent.event.itemId)).toHaveLength(1);
    });

    it("declines an outstanding Codex command approval on stop and resolves it exactly once", async () => {
      // `edit` has to stay `edit`: a session that lands in `plan` refuses
      // provider-native approvals outright and never raises the card.
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "edit",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run the migration.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "codex-exec-approval-req-1",
        method: "item/commandExecution/requestApproval",
        params: {
          turnId: "turn-1",
          itemId: "codex-exec-approval-1",
          command: "/bin/zsh -lc 'npm run migrate'",
        },
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request" && event.event.itemId === "codex-exec-approval-1",
      );

      await service.interrupt({ sessionId: session.id });

      // The app-server holds the request open until ADE answers it, so a stop
      // that only drops the local entry strands it.
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads).toContainEqual(expect.objectContaining({
          id: "codex-exec-approval-req-1",
          result: expect.objectContaining({ decision: "decline" }),
        }));
      });

      const resolutionsFor = (): AgentChatEventEnvelope[] => events.filter((envelope) =>
        envelope.event.type === "pending_input_resolved"
        && envelope.event.itemId === approvalEvent.event.itemId);
      expect(resolutionsFor()).toHaveLength(1);

      // The app-server's own abort lands after the local settle. It must not
      // resolve the same card a second time.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((envelope) =>
          envelope.event.type === "done" && envelope.event.status === "interrupted")).toBe(true);
      });
      expect(resolutionsFor()).toHaveLength(1);
    });

    it("emits a terminal event when a streamed native Codex plan item completes", async () => {
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
        text: "Plan with a streamed native plan item.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          itemId: "codex-plan-streamed",
          delta: "1. Inspect the streamed plan.",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-streamed"
          && event.event.state === "delta",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-streamed",
            type: "plan",
          },
        },
      });

      const completedPlanEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-streamed"
          && event.event.state === "complete"
          && (event.event.streamingText ?? "").includes("Inspect the streamed plan"),
      );
      expect(completedPlanEvent.event.state).toBe("complete");
      expect(completedPlanEvent.event.streamingText).toContain("Inspect the streamed plan");
    });

    it("emits a terminal event when a native Codex plan item completes without text", async () => {
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
        text: "Plan with an empty native plan item.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-empty",
            type: "plan",
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-empty"
          && event.event.state === "active",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-empty",
            type: "plan",
          },
        },
      });

      const completeEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-empty"
          && event.event.state === "complete",
      );
      expect(completeEvent.event.streamingText).toBe("");
    });

    it("keeps native Codex plan deltas under a stable fallback item id", async () => {
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
        text: "Plan with streaming deltas.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          delta: "1. Inspect the service\n",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          delta: "2. Patch the handoff",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === `codex-plan:${session.id}:turn-1`
          && (event.event.streamingText ?? "").includes("Patch the handoff"),
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === `codex-plan:${session.id}:turn-1`
          && event.event.state === "complete"
          && (event.event.streamingText ?? "").includes("Patch the handoff"),
      );

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );
      const request = (approvalEvent.event.detail as { request?: { description?: string } } | undefined)?.request;
      expect(request?.description).toContain("1. Inspect the service");
      expect(request?.description).toContain("2. Patch the handoff");
    });

    it("does not request native Codex plan approval after a failed turn", async () => {
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
        text: "Plan but fail.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          itemId: "codex-plan-failed",
          delta: "1. This should not be approvable.",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } => event.event.type === "plan" && event.event.itemId === "codex-plan-failed",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "Plan mode crashed" },
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } => event.event.type === "status" && event.event.turnStatus === "failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) =>
        event.event.type === "approval_request"
        && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval")
      )).toBe(false);
    });

    it("sends Codex default collaboration mode on turn start outside plan mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(session.permissionMode).toBe("default");
      expect(session.codexApprovalPolicy).toBe("on-request");
      expect(session.codexSandbox).toBe("workspace-write");

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: {
          type?: unknown;
          networkAccess?: unknown;
          readOnlyAccess?: { type?: unknown };
          writableRoots?: unknown[];
          excludeTmpdirEnvVar?: unknown;
          excludeSlashTmp?: unknown;
        };
        effort?: unknown;
        collaborationMode?: Record<string, unknown>;
      } | undefined;
      const collaborationMode = params?.collaborationMode as
        | { mode?: unknown; settings?: { developer_instructions?: unknown } }
        | undefined;

      expect(params?.approvalPolicy).toBe("on-request");
      expect(params?.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(params?.effort).toBe("medium");
      expect(collaborationMode?.mode).toBe("default");
      expect(collaborationMode?.settings?.developer_instructions).toBe("system prompt");
    });

    it("handles Codex /plan prompts inline and sends the next app-server turn in plan mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/plan Please plan the renderer refactor before editing app.tsx.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("plan");
      expect(summary?.interactionMode).toBe("plan");
      expect(summary?.codexApprovalPolicy).toBe("on-request");
      expect(summary?.codexSandbox).toBe("read-only");

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        collaborationMode?: { mode?: unknown };
        input?: Array<{ text?: unknown }>;
      } | undefined;
      const textInput = params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(textInput).toContain("Please plan the renderer refactor before editing app.tsx.");
      expect(textInput).not.toContain("/plan");
      expect(params?.approvalPolicy).toBe("on-request");
      expect(params?.sandboxPolicy?.type).toBe("readOnly");
      expect(params?.collaborationMode?.mode).toBe("plan");
    });

    it("sends fast service tier for supported Codex models when enabled", async () => {
      mockState.codexResponseOverrides.set("thread/start", (payload) => ({
        thread: { id: "thread-fast" },
        serviceTier: (payload.params as { serviceTier?: unknown } | undefined)?.serviceTier ?? null,
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        fastMode: true,
      });

      expect(session.fastMode).toBe(true);

      await service.sendMessage({
        sessionId: session.id,
        text: "Use fast mode.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect((threadStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.fastMode).toBe(true);
      expect(summary?.codexServiceTier).toBe("fast");
      const persisted = readPersistedChatState(session.id);
      expect(persisted.fastMode).toBe(true);
      expect(persisted.codexServiceTier).toBe("fast");
    });

    it("handles /fast commands inline and applies fast tier to the next app-server turn", async () => {
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
        text: "/fast on",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Fast mode is on."
      )).toBe(true);

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "Use fast mode now.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
    });

    it("handles /fast commands for Cursor models advertised as fast in the model catalog", async () => {
      process.env.CURSOR_API_KEY = "crsr_test";
      cursorModelsListMock.mockResolvedValue([
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          parameters: [
            {
              id: "speed",
              displayName: "Speed",
              values: [{ value: "fast", displayName: "Fast" }],
            },
          ],
        },
      ]);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.getModelCatalog({ mode: "force", refreshProvider: "cursor" });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2.5",
        modelId: "cursor/composer-2.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/fast on",
      }, { awaitDispatch: true });

      expect(mockState.cursorSdkSendCalls).toHaveLength(0);
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Fast mode is on."
      )).toBe(true);
    });

    it("passes standard Cursor SDK params when the standard tier is selected", async () => {
      process.env.CURSOR_API_KEY = "crsr_test";
      cursorModelsListMock.mockResolvedValue([
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          parameters: [
            {
              id: "speed",
              displayName: "Speed",
              values: [
                { value: "standard", displayName: "Standard" },
                { value: "fast", displayName: "Fast" },
              ],
            },
          ],
        },
      ]);
      const { service } = createService();
      await service.getModelCatalog({ mode: "force", refreshProvider: "cursor" });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2.5",
        modelId: "cursor/composer-2.5",
        cursorCloudServiceTier: "standard",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Use standard Cursor tier.",
      }, { awaitDispatch: true });

      expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(expect.objectContaining({
        modelParams: [{ id: "speed", value: "standard" }],
      }));
      expect(mockState.cursorSdkSendCalls.at(-1)).toEqual(expect.objectContaining({
        modelParams: [{ id: "speed", value: "standard" }],
      }));
    });

    it("keeps unconnected OpenCode providers out of the model catalog", async () => {
      // The OpenCode directory is models.dev in its entirety (195 providers / ~7.2k
      // models). Emitting all of it made the synced catalog 4.85 MB and stalled or
      // killed the iOS model picker. Only connected providers may reach the catalog.
      replaceDynamicOpenCodeModelDescriptors([
        createDynamicOpenCodeModelDescriptor("", {
          displayName: "GPT 5.4",
          capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
          openCodeProviderId: "openai",
          openCodeModelId: "gpt-5.4",
        }),
        createDynamicOpenCodeModelDescriptor("", {
          displayName: "Nano Model",
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
          openCodeProviderId: "nano-gpt",
          openCodeModelId: "nano-model",
        }),
      ]);
      vi.mocked(probeOpenCodeProviderInventory).mockResolvedValue({
        modelIds: ["opencode/openai/gpt-5.4"],
        providers: [
          { id: "openai", name: "OpenAI", connected: true, modelCount: 1, availableModelCount: 1 },
          { id: "nano-gpt", name: "nano-gpt", connected: false, modelCount: 1, availableModelCount: 0 },
        ],
        error: null,
        descriptors: [],
      });

      const { service } = createService();
      const catalog = await service.getModelCatalog({ mode: "force", refreshProvider: "opencode" });

      const openCodeGroup = catalog.groups.find((group) => group.key === "opencode");
      const modelIds = openCodeGroup?.providers.flatMap((provider) =>
        provider.subsections.flatMap((subsection) => subsection.models.map((model) => model.id)),
      ) ?? [];

      expect(modelIds).toContain("opencode/openai/gpt-5.4");
      expect(modelIds).not.toContain("opencode/nano-gpt/nano-model");
      // The unconnected provider still appears, but as an empty block — that is the
      // connect affordance, and it costs one small object instead of its whole model
      // list. This mirrors OpenCode's own clients, which list every provider in the
      // connect dialog and render model rows only for connected ones.
      const nanoGpt = openCodeGroup?.providers.find((provider) => provider.key === "nano-gpt");
      expect(nanoGpt).toBeDefined();
      expect(nanoGpt?.modelCount).toBe(0);
      expect(nanoGpt?.subsections).toEqual([]);
    });

    it("omits Codex service tier when fast mode was never turned on", async () => {
      mockState.codexResponseOverrides.set("thread/start", (payload) => ({
        thread: { id: "thread-default" },
        serviceTier: (payload.params as { serviceTier?: unknown } | undefined)?.serviceTier ?? null,
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Use standard mode.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      // Verified against a live app-server: omitting inherits the user's
      // config.toml service_tier, while an explicit null forces "default".
      // ADE has no service-tier UI, so it must not name the key at all.
      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(threadStartRequest?.params).not.toHaveProperty("serviceTier");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect(turnStartRequest?.params).not.toHaveProperty("serviceTier");
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.fastMode).toBe(false);
      expect(summary?.codexServiceTier).toBeNull();
      expect(readPersistedChatState(session.id).codexServiceTier).toBeNull();
    });

    it("preserves fast mode selection on unsupported Codex models without naming a tier", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-mini",
        fastMode: true,
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Unsupported fast model should run standard.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(threadStartRequest?.params).not.toHaveProperty("serviceTier");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect(turnStartRequest?.params).not.toHaveProperty("serviceTier");
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
    });

    it("routes Codex /goal pause and resume commands to app-server goal RPCs", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: null,
            tokensUsed: 25,
            timeUsedSeconds: 60,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_001,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal pause",
      }, { awaitDispatch: true });

      const pauseRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(pauseRequest?.params).toMatchObject({
        threadId: expect.any(String),
        status: "paused",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "/goal resume",
      }, { awaitDispatch: true });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        status: "active",
      });
    });

    it("sets typed Codex /goal text and starts a real app-server turn", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
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
        text: "/goal Ship CLI parity",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const goalRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(goalRequest?.params).toMatchObject({
        threadId: expect.any(String),
        objective: "Ship CLI parity",
        status: "active",
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as { input?: Array<{ text?: unknown }> } | undefined;
      const turnInputText = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(turnInputText).toContain("Ship CLI parity");
      expect(turnInputText).not.toContain("/goal");
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.text.includes("/goal")
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(false);
    });

    it("seeds create-time ADE goals into the Codex app-server goal before the first turn", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        goal: "Run quality, tests, ship, merge, and release.",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Continue the work.",
      }, { awaitDispatch: true });

      const goalRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/goal/set");
      const turnRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "turn/start");
      expect(goalRequestIndex).toBeGreaterThan(-1);
      expect(turnRequestIndex).toBeGreaterThan(-1);
      expect(goalRequestIndex).toBeLessThan(turnRequestIndex);
      expect(mockState.codexRequestPayloads[goalRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Run quality, tests, ship, merge, and release.",
        status: "active",
        tokenBudget: null,
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Run quality, tests, ship, merge, and release.",
        status: "active",
        tokenBudget: null,
      });
    });

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

    it("re-arms a stalled Codex turn when recovery chooses Wait", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
        await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

        const result = await service.recoverCodexTurn({
          sessionId: session.id,
          turnId: "turn-1",
          action: "wait",
        });

        expect(result).toEqual({ action: "wait", turnId: "turn-1", status: "waiting" });
        expect(events.some((event) => event.event.type === "system_notice"
          && event.event.message === "Continuing to wait for Codex output.")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(false);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) => event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1")).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends a same-turn Codex status nudge from recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({ sessionId: session.id, turnId: "turn-1", action: "steer" });

      expect(result.status).toBe("nudged");
      const steerRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/steer");
      expect(steerRequest?.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
      expect(JSON.stringify(steerRequest?.params)).toContain("briefly report your current progress");
    });

    it("interrupts and retries a stalled Codex turn on the same thread", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "interrupt_retry_same_thread",
      });

      expect(result.status).toBe("retrying");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(true);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/start")).toHaveLength(1);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(false);
    });

    it("finalizes the adopted Codex turn before retrying recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });
      mockState.codexResponseOverrides.set("turn/interrupt", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return params.turnId === "turn-1"
          ? { error: { code: -32000, message: "expected active turn id turn-1 but found turn-real" } }
          : {};
      });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "interrupt_retry_same_thread",
      });

      expect(result.status).toBe("retrying");
      const interrupts = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt");
      expect(interrupts.map((payload) => (payload.params as Record<string, unknown>).turnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
    });

    it("restarts app-server, resumes the Codex thread, and retries stalled work", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "restart_resume_thread",
      });

      expect(result.status).toBe("resumed");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume"
        && (payload.params as any)?.threadId === "thread-1")).toBe(true);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
    });

    it("aggregates optional Codex MCP startup failures and auto-recovers a silent first attempt once", async () => {
      vi.useFakeTimers();
      try {
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: {
            serverName: "local-tools",
            status: "failed",
            message: "http/request failed: error sending request",
          },
        });
        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: {
            serverName: "local-tools",
            status: "failed",
            message: "http/request failed: error sending request",
          },
        });

        await Promise.resolve();
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("Codex MCP server 'local-tools' is unavailable")
        )).toBe(false);
        expect(events.filter((event) =>
          event.event.type === "turn_diagnostics"
          && event.event.optionalIntegrationFailures?.some((failure) =>
            failure.integration === "local-tools"
          )
        )).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_recovery"
            && event.event.state === "recovered"
            && event.event.automatic
          )).toBe(true);
        });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("persists the Codex automatic-recovery guard across restart while keeping a new turn eligible", async () => {
      vi.useFakeTimers();
      try {
        const first = createService();
        const session = await first.service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await first.service.sendMessage({
          sessionId: session.id,
          text: "Keep this turn running.",
        }, { awaitDispatch: true });
        await first.service.recoverCodexTurn({
          sessionId: session.id,
          turnId: "turn-1",
          action: "wait",
        });

        expect(readPersistedChatState(session.id).codexAutomaticRecoveryAttempted)
          .toBe(true);
        first.service.forceDisposeAll();

        const restartedEvents: AgentChatEventEnvelope[] = [];
        const restarted = createService({
          onEvent: (event: AgentChatEventEnvelope) => restartedEvents.push(event),
        });
        await restarted.service.resumeSession({ sessionId: session.id });
        mockState.emitCodexPayload({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        });
        await Promise.resolve();
        const resumeRequestsBeforeWatchdog = mockState.codexRequestPayloads
          .filter((payload) => payload.method === "thread/resume").length;

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimerCondition(
          () => restartedEvents.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.automaticRecoveryAttempted === true),
          "the resumed turn to remain stalled without another automatic recovery",
        );

        expect(restartedEvents.some((event) =>
          event.event.type === "codex_turn_recovery"
          && event.event.turnId === "turn-1"
          && event.event.automatic)).toBe(false);
        expect(mockState.codexRequestPayloads
          .filter((payload) => payload.method === "thread/resume")).toHaveLength(
            resumeRequestsBeforeWatchdog,
          );

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", items: [] },
          },
        });
        await Promise.resolve();
        await restarted.service.sendMessage({
          sessionId: session.id,
          text: "Start a genuinely new turn.",
        }, { awaitDispatch: true });
        expect(readPersistedChatState(session.id).codexAutomaticRecoveryAttempted)
          .not.toBe(true);

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimerCondition(
          () => restartedEvents.some((event) =>
            event.event.type === "codex_turn_recovery"
            && event.event.turnId === "turn-2"
            && event.event.state === "recovered"
            && event.event.automatic),
          "the new turn to complete its first automatic recovery",
        );
        expect(readPersistedChatState(session.id).codexAutomaticRecoveryAttempted)
          .toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("warns without killing a Codex turn after ten minutes of mid-turn inactivity", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await service.sendMessage({ sessionId: session.id, text: "Run the task." }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: {
              id: "collab-1",
              type: "collabAgentToolCall",
              tool: "spawn_agent",
              prompt: "Inspect one bounded area.",
              status: "inProgress",
            },
          },
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("tracks accepted Codex follow-ups until the app-server proves they were processed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });

      sessionService.clearTurnStartMarkers.mockClear();
      const first = await service.steerUserMessage({
        sessionId: session.id,
        text: "First follow-up.",
      });
      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith(session.id);
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.steerId === first.steerId
        && event.event.deliveryState === "accepted"
        && event.event.processed === false
      )).toBe(true);

      sessionService.clearTurnStartMarkers.mockClear();
      mockState.codexResponseOverrides.set("turn/steer", {
        error: { code: -32603, message: "provider rejected steer" },
      });
      await expect(service.sendMessage({
        sessionId: session.id,
        text: "Rejected follow-up.",
      }, {
        routeActiveToSteer: true,
      })).rejects.toThrow("provider rejected steer");
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      mockState.codexResponseOverrides.delete("turn/steer");

      await service.steerUserMessage({
        sessionId: session.id,
        text: "   ",
      });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();

      await service.steer({
        sessionId: session.id,
        text: "Agent-originated follow-up.",
      });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();

      mockState.emitCodexPayload({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "user-followup-1",
            type: "userMessage",
            content: [{ type: "text", text: "First follow-up." }],
          },
        },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === first.steerId
          && event.event.deliveryState === "processed"
          && event.event.processed === true
        )).toBe(true);
      });

      sessionService.clearTurnStartMarkers.mockClear();
      const second = await service.steer({ sessionId: session.id, text: "Second follow-up." });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === second.steerId
          && event.event.deliveryState === "unprocessed"
          && event.event.processed === false
        )).toBe(true);
      });
    });

    it("correlates combined Codex user-message content without consuming another accepted steer", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });

      const first = await service.steer({ sessionId: session.id, text: "First follow-up." });
      const second = await service.steer({ sessionId: session.id, text: "Second follow-up." });

      mockState.emitCodexPayload({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "unmatched-user-followup",
            type: "userMessage",
            content: [{ type: "text", text: "A provider message unrelated to either steer." }],
          },
        },
      });
      mockState.emitCodexPayload({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "combined-user-followup",
            type: "userMessage",
            content: [
              { type: "text", text: "System context supplied by ADE." },
              { type: "text", text: "Second follow-up." },
            ],
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === second.steerId
          && event.event.deliveryState === "processed"
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.steerId === first.steerId
        && event.event.deliveryState === "processed"
      )).toBe(false);

      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "user_message"
          && event.event.steerId === first.steerId
          && event.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.steerId === second.steerId
        && event.event.deliveryState === "unprocessed"
      )).toBe(false);
    });

    it("restores accepted Codex follow-ups from durable history after a runtime restart", async () => {
      installRealTranscriptParser();
      const first = createService();
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      const transcriptPath = first.sessionService.get(session.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      first.service.forceDisposeAll();
      fs.mkdirSync(path.dirname(String(transcriptPath)), { recursive: true });
      fs.writeFileSync(String(transcriptPath), [
        JSON.stringify({
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Persist this follow-up.",
            displayText: "Persist this follow-up.",
            steerId: "steer-restart-1",
            turnId: "turn-old",
            deliveryState: "accepted",
            processed: false,
          },
        }),
        JSON.stringify({
          sessionId: session.id,
          timestamp: "2026-07-25T05:21:00.000Z",
          sequence: 2,
          event: {
            type: "done",
            status: "interrupted",
            turnId: "turn-old",
          },
        }),
      ].join("\n") + "\n", "utf8");

      const events: AgentChatEventEnvelope[] = [];
      const second = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await second.service.resumeSession({ sessionId: session.id });

      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === "steer-restart-1"
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
    });

    it("runs an unprocessed Codex follow-up once and records an idempotent durable resolution", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });
      const followUp = await service.steer({ sessionId: session.id, text: "Run this exactly once." });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
      const turnStartsBefore = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length;

      const first = await service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });
      const second = await service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });

      expect(first).toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        status: "completed",
        replacementMessageId: expect.any(String),
      });
      expect(second).toEqual({
        ...first,
        status: "already_completed",
      });
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBefore + 1);
      expect(events.filter((entry) =>
        entry.event.type === "user_message"
        && entry.event.metadata?.replayedFromUnprocessedSteer?.sourceSteerId === followUp.steerId
      )).toHaveLength(1);
      expect(events.filter((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === followUp.steerId
        && entry.event.action === "run_next"
      )).toHaveLength(1);
    });

    it("does not treat optimistic replay rows as a durable backend dispatch after restart", async () => {
      installRealTranscriptParser();
      const first = createService();
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      first.service.forceDisposeAll();

      const sourceSteerId = "steer-restart-1";
      const optimisticReplacementMessageId = "replacement-before-backend-ack";
      writeTestTranscriptEnvelopes(session.id, [
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Run this after the current turn.",
            steerId: sourceSteerId,
            deliveryState: "unprocessed",
            processed: false,
            turnId: "turn-old",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:01.000Z",
          sequence: 2,
          event: {
            type: "user_message",
            text: "Run this after the current turn.",
            turnId: "optimistic-turn",
            metadata: {
              replayedFromUnprocessedSteer: {
                sourceSteerId,
                action: "run_next",
                replacementMessageId: optimisticReplacementMessageId,
              },
            },
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:01.001Z",
          sequence: 3,
          event: {
            type: "status",
            turnStatus: "started",
            turnId: "optimistic-turn",
          },
        },
      ]);

      const emitted: AgentChatEventEnvelope[] = [];
      const second = createService({
        onEvent: (event: AgentChatEventEnvelope) => emitted.push(event),
      });
      const turnStartsBefore = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      const retried = await second.service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: sourceSteerId,
        action: "run_next",
      });

      expect(retried).toMatchObject({
        steerId: sourceSteerId,
        action: "run_next",
        status: "completed",
        replacementMessageId: expect.any(String),
      });
      expect(retried.replacementMessageId).not.toBe(optimisticReplacementMessageId);
      expect(emitted.some((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === sourceSteerId
        && entry.event.action === "run_next"
      )).toBe(true);
      expect(emitted.some((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.replacementMessageId === retried.replacementMessageId
      )).toBe(true);
      expect(mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBefore + 1);
    });

    it("reconstructs a missing replay resolution from the durable backend dispatch receipt", async () => {
      installRealTranscriptParser();
      const firstEvents: AgentChatEventEnvelope[] = [];
      const first = createService({
        onEvent: (event: AgentChatEventEnvelope) => firstEvents.push(event),
      });
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await first.service.sendMessage(
        { sessionId: session.id, text: "Start." },
        { awaitDispatch: true },
      );
      const followUp = await first.service.steer({
        sessionId: session.id,
        text: "Run this once after restart.",
      });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(firstEvents.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });

      const dispatched = await first.service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });
      const persistedReceipt = readPersistedChatState(session.id)
        .unprocessedMessageResolutionReceipts
        ?.find((receipt: Record<string, unknown>) => receipt.steerId === followUp.steerId);
      expect(persistedReceipt).toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        state: "completed",
        replacementMessageId: dispatched.replacementMessageId,
      });

      first.service.forceDisposeAll();
      await new Promise((resolve) => setTimeout(resolve, 250));
      writeTestTranscriptEnvelopes(session.id, [
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Run this once after restart.",
            steerId: followUp.steerId,
            deliveryState: "unprocessed",
            processed: false,
            turnId: "turn-old",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-07-25T05:20:01.000Z",
          sequence: 2,
          event: {
            type: "user_message",
            text: "Run this once after restart.",
            metadata: {
              replayedFromUnprocessedSteer: {
                sourceSteerId: followUp.steerId,
                action: "run_next",
                replacementMessageId: dispatched.replacementMessageId!,
              },
            },
          },
        },
      ]);

      const restartedEvents: AgentChatEventEnvelope[] = [];
      const restarted = createService({
        onEvent: (event: AgentChatEventEnvelope) => restartedEvents.push(event),
      });
      const turnStartsBeforeRetry = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      const retried = await restarted.service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      });

      expect(retried).toEqual({
        steerId: followUp.steerId,
        action: "run_next",
        status: "already_completed",
        replacementMessageId: dispatched.replacementMessageId,
      });
      expect(mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBeforeRetry);
      expect(restartedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message_resolution",
            steerId: followUp.steerId,
            action: "run_next",
            replacementMessageId: dispatched.replacementMessageId,
          }),
        }),
      ]));
    });

    it("allows Run next to retry when the optimistic replacement never reached the provider", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage(
        { sessionId: session.id, text: "Start." },
        { awaitDispatch: true },
      );
      const followUp = await service.steer({
        sessionId: session.id,
        text: "Retry me if the provider rejects the dispatch.",
      });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });

      mockState.codexResponseOverrides.set("turn/start", {
        error: { code: -32_000, message: "replay start exploded" },
      });
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).rejects.toThrow(/replay start exploded/i);
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "done"
          && entry.event.status === "failed"
        )).toBe(true);
      });

      mockState.codexResponseOverrides.delete("turn/start");
      const turnStartsBeforeRetry = mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start").length;
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).resolves.toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        status: "completed",
        replacementMessageId: expect.any(String),
      });
      expect(mockState.codexRequestPayloads
        .filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBeforeRetry + 1);
    });

    it("keeps Run next retryable when storage pressure prevents backend dispatch", async () => {
      installRealTranscriptParser();
      let allowTurns = true;
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        diskPressureMonitor: {
          canPerform: vi.fn(() => allowTurns
            ? { allowed: true, state: "normal" }
            : {
                allowed: false,
                state: "exhausted",
                code: "disk_full",
                message: "Your computer is almost out of storage.",
              }),
        },
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage(
        { sessionId: session.id, text: "Start." },
        { awaitDispatch: true },
      );
      const followUp = await service.steer({
        sessionId: session.id,
        text: "Run this when storage is ready.",
      });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });

      allowTurns = false;
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).rejects.toThrow(/provider did not accept/i);
      expect(events.some((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === followUp.steerId
      )).toBe(false);

      allowTurns = true;
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "run_next",
      })).resolves.toMatchObject({
        steerId: followUp.steerId,
        action: "run_next",
        status: "completed",
      });
    });

    it("dismisses an unprocessed Codex follow-up idempotently without starting a turn", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Start." }, { awaitDispatch: true });
      const followUp = await service.steer({ sessionId: session.id, text: "Dismiss me." });
      mockState.emitCodexPayload({
        method: "turn/aborted",
        params: { turnId: "turn-1" },
      });
      await vi.waitFor(() => {
        expect(events.some((entry) =>
          entry.event.type === "user_message"
          && entry.event.steerId === followUp.steerId
          && entry.event.deliveryState === "unprocessed"
        )).toBe(true);
      });
      const turnStartsBefore = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length;

      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "dismiss",
      })).resolves.toMatchObject({ status: "completed", action: "dismiss" });
      await expect(service.resolveUnprocessedMessage({
        sessionId: session.id,
        steerId: followUp.steerId,
        action: "dismiss",
      })).resolves.toMatchObject({ status: "already_completed", action: "dismiss" });

      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(turnStartsBefore);
      expect(events.filter((entry) =>
        entry.event.type === "user_message_resolution"
        && entry.event.steerId === followUp.steerId
        && entry.event.action === "dismiss"
      )).toHaveLength(1);
    });

    it("maps the provider-neutral recovery contract onto Codex recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      await expect(service.recoverTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "nudge",
      })).resolves.toEqual({
        action: "nudge",
        turnId: "turn-1",
        status: "nudged",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(true);
    });

    it("clears the Codex no-output watchdog when an approval request is surfaced", async () => {
      vi.useFakeTimers();
      try {
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: ".",
            reason: "Run tests",
          },
        });

        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-1"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(120_000);

        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("has not streamed model or tool output yet")
        )).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-arms the Codex watchdog after the user answers a suspended approval", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await service.sendMessage(
          { sessionId: session.id, text: "Keep working." },
          { awaitDispatch: true },
        );
        mockState.emitCodexPayload({
          id: "approval-rearm-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-rearm-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: ".",
            reason: "Run tests",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-rearm-1"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
        // Let the suspended reconcile finish and drop its in-flight lock
        // before the answer re-arms the timer. Otherwise the second 10-minute
        // advance can no-op while that first reconcile is still awaiting a
        // thread/read microtask.
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

        await service.respondToInput({
          sessionId: session.id,
          itemId: "cmd-rearm-1",
          decision: "accept",
        });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-arms the Codex watchdog after full-auto resolves a suspended approval", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
          if (mode === "full-auto") {
            return { approvalPolicy: "never", sandbox: "danger-full-access" };
          }
          return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        });
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          permissionMode: "edit",
        });
        await service.sendMessage(
          { sessionId: session.id, text: "Keep working." },
          { awaitDispatch: true },
        );
        mockState.emitCodexPayload({
          id: "auto-resolved-approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-auto-resolved-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: tmpRoot,
            reason: "Run tests",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-auto-resolved-1"
          )).toBe(true);
        });

        await service.updateSession({
          sessionId: session.id,
          permissionMode: "full-auto",
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "pending_input_resolved"
            && event.event.itemId === "cmd-auto-resolved-1"
            && event.event.resolution === "accepted"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-arms the Codex watchdog when the app server resolves a suspended approval", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        await service.sendMessage(
          { sessionId: session.id, text: "Keep working." },
          { awaitDispatch: true },
        );
        mockState.emitCodexPayload({
          id: "server-resolved-approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-server-resolved-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: ".",
            reason: "Run tests",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-server-resolved-1"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);

        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            requestId: "server-resolved-approval-1",
          },
        });
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "pending_input_resolved"
            && event.event.itemId === "cmd-server-resolved-1"
          )).toBe(true);
        });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconciles a completed silent Codex turn from app-server state before reporting a stall", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 7, outputTokens: 3 },
              items: [
                {
                  id: "msg-1",
                  type: "agentMessage",
                  text: "Recovered assistant output.",
                },
              ],
            },
          ],
          nextCursor: null,
        }));
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed"
          )).toBe(true);
        });

        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/read")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/turns/list")).toBe(true);
        expect(events.some((event) =>
          event.event.type === "text"
          && event.event.text.includes("Recovered assistant output.")
        )).toBe(true);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not complete a reconciled MCP tool call while app-server still reports it running", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [
                {
                  id: "mcp-1",
                  type: "mcpToolCall",
                  server: "local-tools",
                  tool: "probe",
                  pluginId: "local-plugin",
                  appContext: {
                    connectorId: "local",
                    appName: "Local tools",
                    actionName: "Probe file",
                    resourceUri: "ui://local/probe",
                  },
                  status: "running",
                  arguments: { path: "README.md" },
                },
              ],
            },
          ],
          nextCursor: null,
        }));
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "tool_call"
            && event.event.itemId === "mcp-1"
            && event.event.mcp?.pluginId === "local-plugin"
            && event.event.mcp?.appContext?.appName === "Local tools"
          )).toBe(true);
        }, { steps: 200, realYield: true });

        expect(events.some((event) =>
          event.event.type === "tool_result"
          && event.event.itemId === "mcp-1"
        )).toBe(false);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves the Codex imageGeneration lifecycle and local output path", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Generate a tiny moon icon." }, { awaitDispatch: true });

      const item = {
        id: "image-1",
        type: "imageGeneration",
        status: "inProgress",
        prompt: "A tiny moon icon",
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item },
      });
      const started = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
          event.event.type === "codex_image_generation" && event.event.itemId === "image-1",
      );
      expect(started.event).toMatchObject({
        prompt: "A tiny moon icon",
        status: "running",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            ...item,
            status: "completed",
            revisedPrompt: "A crisp crescent moon icon",
            result: "/tmp/generated-moon.png",
          },
        },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "codex_image_generation"
          && event.event.itemId === "image-1"
          && event.event.status === "completed"
          && event.event.savedPath === "/tmp/generated-moon.png"
        )).toBe(true);
      });
    });

    it("preserves live Codex MCP app metadata for Sources aggregation", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "Use the docs connector." }, { awaitDispatch: true });

      const item = {
        id: "mcp-live-1",
        type: "mcpToolCall",
        server: "openaiDeveloperDocs",
        tool: "search",
        status: "inProgress",
        arguments: { query: "GPT-5.6" },
        pluginId: "openai-docs",
        appContext: {
          connectorId: "openai-docs",
          linkId: "docs-link",
          resourceUri: "ui://openai-docs/search",
          appName: "OpenAI Docs",
          templateId: "search-results",
          actionName: "Search documentation",
        },
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "tool_call" }> } =>
          event.event.type === "tool_call" && event.event.itemId === "mcp-live-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            ...item,
            status: "completed",
            result: { title: "GPT-5.6", url: "https://developers.openai.com/api/docs/models" },
          },
        },
      });
      const completed = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }> } =>
          event.event.type === "tool_result" && event.event.itemId === "mcp-live-1",
      );

      expect(completed.event).toMatchObject({
        tool: "openaiDeveloperDocs:search",
        status: "completed",
        mcp: {
          server: "openaiDeveloperDocs",
          tool: "search",
          pluginId: "openai-docs",
          resourceUri: "ui://openai-docs/search",
          appContext: {
            connectorId: "openai-docs",
            appName: "OpenAI Docs",
            actionName: "Search documentation",
          },
        },
      });
    });

    it("re-arms the Codex watchdog after partial same-thread recovery", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let turnsListCalls = 0;
        mockState.codexResponseOverrides.set("thread/turns/list", () => {
          turnsListCalls += 1;
          return {
            data: [
              {
                id: "turn-1",
                status: "inProgress",
                items: [
                  {
                    id: "reasoning-1",
                    type: "reasoning",
                    summary: ["Recovered partial reasoning."],
                  },
                ],
              },
            ],
            nextCursor: null,
          };
        });
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "reasoning"
            && event.event.text.includes("Recovered partial reasoning.")
          )).toBe(true);
        });
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.reason === "no_progress"
          )).toBe(true);
        });
        expect(events.filter((event) =>
          event.event.type === "reasoning"
          && event.event.text.includes("Recovered partial reasoning.")
        )).toHaveLength(1);
        expect(turnsListCalls).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not double-finalize when a normal Codex completion wins the silent-turn reconciliation race", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.delayedCodexMethods.add("thread/turns/list");
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 7, outputTokens: 3 },
              items: [
                {
                  id: "msg-after-complete",
                  type: "agentMessage",
                  text: "Recovered after the normal completion.",
                },
              ],
            },
          ],
          nextCursor: null,
        }));
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(mockState.pendingCodexResponses).toHaveLength(1);
        });

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 11, outputTokens: 5 },
            },
          },
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed",
        );

        mockState.flushCodexResponses();
        await Promise.resolve();

        const doneEvents = events.filter((event) =>
          event.event.type === "done"
          && event.event.turnId === "turn-1"
          && event.event.status === "completed"
        );
        expect(doneEvents).toHaveLength(1);
        expect(events.some((event) =>
          event.event.type === "text"
          && event.event.text.includes("Recovered after the normal completion.")
        )).toBe(false);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not emit a stale stall when a normal Codex completion wins after turns-list fails", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.delayedCodexMethods.add("thread/turns/list");
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          error: { code: -32000, message: "thread state unavailable" },
        }));
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(mockState.pendingCodexResponses).toHaveLength(1);
        });

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 11, outputTokens: 5 },
            },
          },
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed",
        );

        mockState.flushCodexResponses();
        await Promise.resolve();

        expect(events.filter((event) =>
          event.event.type === "done"
          && event.event.turnId === "turn-1"
          && event.event.status === "completed"
        )).toHaveLength(1);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && (
            event.event.message.includes("has not streamed model or tool output yet")
            || event.event.message.includes("could not confirm its app-server state")
          )
        )).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("routes structured Codex stall notices to a spawn parent without auto-handoff", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const parent = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });
        const child = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          orchestrationParentSessionId: parent.id,
          spawnKind: "subagent",
        });

        await service.sendMessage({
          sessionId: child.id,
          text: "Keep working.",
        }, { awaitDispatch: true });
        await service.recoverCodexTurn({
          sessionId: child.id,
          turnId: "turn-1",
          action: "wait",
        });

        await vi.advanceTimersByTimeAsync(120_000);
        await waitForFakeTimers(() => {
          expect(events.some((event) =>
            event.sessionId === parent.id
            && event.event.type === "codex_turn_stalled"
            && event.event.sourceSessionId === child.id
          )).toBe(true);
        });

        expect(events.some((event) =>
          event.sessionId === child.id
          && event.event.type === "codex_turn_stalled"
          && event.event.reason === "no_output"
        )).toBe(true);
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "turn_health"
          && event.event.sourceSessionId === child.id
        )).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the Codex no-output watchdog when useful turn events arrive", async () => {
      vi.useFakeTimers();
      try {
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
          text: "Keep working.",
        }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { id: "item-1", type: "agentMessage" },
          },
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(120_000);

        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("has not streamed model or tool output yet")
        )).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("exposes typed Codex goal controls with unlimited budgets and persisted summaries", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective ?? "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
            tokensUsed: 42,
            timeUsedSeconds: 12,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const goal = await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(goal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
        tokensUsed: 42,
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
      expect(readPersistedChatState(session.id).codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });

      mockState.codexRequestPayloads = [];
      await service.setCodexGoalStatus({
        sessionId: session.id,
        status: "paused",
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        status: "paused",
        tokenBudget: null,
      });

      mockState.codexRequestPayloads = [];
      await service.clearCodexGoal({ sessionId: session.id });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/clear")?.params).toMatchObject({
        threadId: "thread-1",
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("does not emit a visible Codex goal-clear event when no goal was known", async () => {
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
        text: "Start a normal turn.",
      }, { awaitDispatch: true });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/cleared",
        params: { threadId: "thread-1" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) => event.event.type === "codex_goal_cleared")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("emits a Codex goal-clear event when a known goal is cleared by app-server", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/cleared",
        params: { threadId: "thread-1" },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_cleared",
      );
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("deduplicates repeated Codex goal updates while retaining latest usage state", async () => {
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
        text: "Start working.",
      }, { awaitDispatch: true });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
            tokensUsed: 25,
            updatedAt: 1_760_000_001,
          },
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_updated"
          && event.event.goal?.objective === "Ship CLI parity",
      );
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
            tokensUsed: 50,
            timeUsedSeconds: 12,
            updatedAt: 1_760_000_002,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) => event.event.type === "codex_goal_updated")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
        tokensUsed: 50,
        timeUsedSeconds: 12,
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "paused",
            tokenBudget: null,
            tokensUsed: 51,
            updatedAt: 1_760_000_003,
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_updated"
          && event.event.goal?.status === "paused",
      );
    });

    it("refreshes a missing Codex goal without emitting a misleading goal-update chip", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: "active",
            tokenBudget: null,
          },
        };
      });
      mockState.codexResponseOverrides.set("thread/goal/get", () => ({
        goal: null,
      }));
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      events.length = 0;

      await expect(service.getCodexGoal({ sessionId: session.id })).resolves.toBeNull();

      expect(events.some((event) => event.event.type === "codex_goal_updated")).toBe(false);
      expect(events.some((event) => event.event.type === "codex_goal_cleared")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("clears persisted Codex goals after restart by resuming the thread first", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      expect(readPersistedChatState(session.id)).toMatchObject({
        threadId: "thread-1",
        codexGoal: {
          objective: "Ship CLI parity",
          status: "active",
          tokenBudget: null,
        },
      });

      mockState.codexRequestPayloads = [];
      const resumed = createService().service;
      await resumed.clearCodexGoal({ sessionId: session.id });

      const resumeRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/resume");
      const clearRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/goal/clear");
      expect(resumeRequestIndex).toBeGreaterThanOrEqual(0);
      expect(clearRequestIndex).toBeGreaterThan(resumeRequestIndex);
      expect(mockState.codexRequestPayloads[resumeRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
        excludeTurns: true,
      });
      expect(mockState.codexRequestPayloads[clearRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
      expect((await resumed.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("does not rotate to a fresh Codex thread when a goal-only resume fails", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      expect(readPersistedChatState(session.id).threadId).toBe("thread-1");

      mockState.codexRequestPayloads = [];
      mockState.codexResponseOverrides.set("thread/resume", {
        error: { code: -32000, message: "resume unavailable" },
      });
      const resumed = createService().service;

      await expect(resumed.setCodexGoal({
        sessionId: session.id,
        objective: "Keep shipping",
      })).rejects.toThrow("Could not resume this Codex thread for goal controls");

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
      expect(readPersistedChatState(session.id).threadId).toBe("thread-1");
      expect((await resumed.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
    });

    it("adopts the plan mode a resumed Codex thread reports (0.156+)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({ sessionId: session.id, objective: "Ship CLI parity" });
      expect((await service.getSessionSummary(session.id))?.interactionMode ?? "default").toBe("default");

      mockState.codexResponseOverrides.set("thread/resume", {
        thread: { id: "thread-1" },
        collaborationMode: { mode: "plan", settings: {} },
      });
      const resumed = createService().service;
      await resumed.setCodexGoal({ sessionId: session.id, objective: "Keep shipping" });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      expect((await resumed.getSessionSummary(session.id))?.interactionMode).toBe("plan");
    });

    it("rejects Codex goals over the app-server objective limit", async () => {
      const tooLongGoal = "x".repeat(4_001);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await expect(service.setCodexGoal({
        sessionId: session.id,
        objective: tooLongGoal,
      })).rejects.toThrow("Goal is too long. Keep it under 4,000 characters.");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);

      await service.sendMessage({
        sessionId: session.id,
        text: `/goal ${tooLongGoal}`,
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Goal is too long. Keep it under 4,000 characters."
      )).toBe(true);
    });

    it("asks before replacing an existing typed Codex goal", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
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
        text: "/goal set Existing goal",
      }, { awaitDispatch: true });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal Replacement goal",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: PendingInputRequest } | undefined)
            : undefined;
          return event.event.type === "approval_request"
            && detail?.request?.providerMetadata?.kind === "codex_goal_replace";
        },
      );
      const request = (approvalEvent.event.detail as { request?: PendingInputRequest } | undefined)?.request;
      expect(request?.questions[0]?.options?.map((option) => option.value)).toEqual(["update_goal", "clear_goal"]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        answers: {
          goal_action: "update_goal",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) =>
          payload.method === "thread/goal/set"
          && (payload.params as { objective?: unknown } | undefined)?.objective === "Replacement goal"
        )).toBe(true);
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
    });

    it("automatically removes incoming Codex goal token limits and resumes limited goals", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective ?? "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: Object.prototype.hasOwnProperty.call(params, "tokenBudget") ? params.tokenBudget : 5000,
            tokensUsed: 125,
            timeUsedSeconds: 90,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_010,
          },
        };
      });

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
        text: "Start working.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.codexRequestPayloads = [];

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "budgetLimited",
            tokenBudget: 5000,
            tokensUsed: 125,
            timeUsedSeconds: 90,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_001,
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const clearRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(clearRequest?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message === "Goal limit removed. ADE keeps goals unlimited."
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "codex_goal_updated"
        && event.event.goal?.status === "budget_limited"
      )).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "codex_goal_updated",
            goal: expect.objectContaining({
              status: "active",
              tokenBudget: null,
              timeUsedSeconds: 90,
            }),
          }),
        }),
      ]));
    });

    it("backs off automatic Codex goal budget clearing after app-server failures", async () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      mockState.delayedCodexMethods.add("thread/goal/set");

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
        text: "Start working.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.codexRequestPayloads = [];

      const emitBudgetLimitedGoal = () => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "thread/goal/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            goal: {
              objective: "Ship CLI parity",
              status: "budgetLimited",
              tokenBudget: 5000,
              tokensUsed: 125,
              timeUsedSeconds: 90,
              createdAt: 1_760_000_000,
              updatedAt: 1_760_000_001,
            },
          },
        });
      };

      emitBudgetLimitedGoal();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/goal/set")).toHaveLength(1);
      });

      const clearRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: clearRequest?.id,
        error: { code: -32001, message: "goal RPC failed" },
      });
      mockState.pendingCodexResponses = [];

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message === "Goal update failed: goal RPC failed"
        )).toBe(true);
      });

      mockState.codexRequestPayloads = [];
      emitBudgetLimitedGoal();
      await Promise.resolve();
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);

      nowSpy.mockReturnValue(1_031_000);
      emitBudgetLimitedGoal();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const retryRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: retryRequest?.id,
        result: {
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
          },
        },
      });
      mockState.pendingCodexResponses = [];
    });

    it("treats /goal set reserved words as objective text", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal set clear",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        threadId: expect.any(String),
        objective: "clear",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/clear")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("reports Codex /goal slash command failures without completing a fake slash turn", async () => {
      mockState.delayedCodexMethods.add("thread/goal/set");
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
        text: "/goal status paused",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const goalRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(goalRequest?.id).toBeTruthy();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: goalRequest?.id,
        error: { code: -32001, message: "goal RPC failed" },
      });
      await sendPromise;

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Goal update failed: goal RPC failed"
      )).toBe(true);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(false);
    });

    it("reports Codex /goal slash timeouts without tearing down the runtime", async () => {
      mockState.delayedCodexMethods.add("thread/goal/set");
      vi.useFakeTimers();
      try {
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
          text: "/goal status paused",
        }, { awaitDispatch: true });

        await waitForFakeTimers(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
        });
        await vi.advanceTimersByTimeAsync(10_050);
        await sendPromise;

        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("timed out")
        )).toBe(true);

        mockState.delayedCodexMethods.clear();
        mockState.codexRequestPayloads = [];
        await service.sendMessage({
          sessionId: session.id,
          text: "Continue after the slash timeout.",
        }, { awaitDispatch: true });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("routes Codex goal edits through goal RPC while a turn is active instead of turn steer", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start a long-running turn.",
      }, { awaitDispatch: true });

      mockState.codexRequestPayloads = [];
      await service.steer({
        sessionId: session.id,
        text: "/goal set Updated from UI",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        objective: "Updated from UI",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);
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

    it("keeps fast mode switching away from Codex only onto a model with a fast tier", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        fastMode: true,
      });

      const onOpus = await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-opus-5",
      });
      expect(onOpus.provider).toBe("claude");
      expect(onOpus.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);

      const onSonnet = await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-5",
      });
      expect(onSonnet.fastMode).not.toBe(true);
      expect((await service.getSessionSummary(session.id))?.fastMode).not.toBe(true);
      expect(readPersistedChatState(session.id).fastMode).not.toBe(true);
    });

    it("re-resumes Codex threads when fast mode changes mid-session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Initial standard turn.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: `turn-${mockState.codexTurnCounter}`,
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      mockState.codexRequestPayloads = [];
      const updated = await service.updateSession({
        sessionId: session.id,
        fastMode: true,
      });
      expect(updated.fastMode).toBe(true);

      await service.sendMessage({
        sessionId: session.id,
        text: "Next turn should re-resume fast.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      expect((resumeRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
    });

    it("preserves Codex edit sessions as untrusted workspace-write", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      });

      expect(session.permissionMode).toBe("edit");
      expect(session.codexApprovalPolicy).toBe("untrusted");
      expect(session.codexSandbox).toBe("workspace-write");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("edit");
    });

    it("starts Codex full-auto sessions with danger-full-access and never approval", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and then edit files if needed.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const params = threadStartRequest?.params as {
        approvalPolicy?: unknown;
        sandbox?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
        config?: { model_reasoning_effort?: unknown };
      } | undefined;
      expect(params?.approvalPolicy).toBe("never");
      expect(params?.sandbox).toBe("danger-full-access");
      expect(params?.config?.model_reasoning_effort).toBe("medium");
      expect(params?.effort).toBeUndefined();
      expect(params?.reasoningEffort).toBeUndefined();
      expect(params?.reasoning_effort).toBeUndefined();

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("never");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("dangerFullAccess");
      expect(turnStartParams?.effort).toBe("medium");
      expect(turnStartParams?.reasoningEffort).toBeUndefined();
      expect(turnStartParams?.reasoning_effort).toBeUndefined();
    });

    it("serializes every Codex permission mode to the app-server wire shapes", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        if (mode === "default") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        if (mode === "config-toml") return null;
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const cases = [
        {
          mode: "plan" as const,
          approvalPolicy: "on-request",
          lifecycleSandbox: "read-only",
          turnSandboxType: "readOnly",
        },
        {
          mode: "default" as const,
          approvalPolicy: "on-request",
          lifecycleSandbox: "workspace-write",
          turnSandboxType: "workspaceWrite",
        },
        {
          mode: "edit" as const,
          approvalPolicy: "untrusted",
          lifecycleSandbox: "workspace-write",
          turnSandboxType: "workspaceWrite",
        },
        {
          mode: "full-auto" as const,
          approvalPolicy: "never",
          lifecycleSandbox: "danger-full-access",
          turnSandboxType: "dangerFullAccess",
        },
        {
          mode: "config-toml" as const,
          approvalPolicy: undefined,
          lifecycleSandbox: undefined,
          turnSandboxType: undefined,
        },
      ];

      for (const scenario of cases) {
        mockState.codexRequestPayloads = [];
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          permissionMode: scenario.mode,
        });

        await service.sendMessage({
          sessionId: session.id,
          text: `Probe ${scenario.mode} permissions.`,
        });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        });

        const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
        const threadParams = threadStartRequest?.params as {
          approvalPolicy?: unknown;
          sandbox?: unknown;
        } | undefined;
        expect(threadParams?.approvalPolicy).toBe(scenario.approvalPolicy);
        expect(threadParams?.sandbox).toBe(scenario.lifecycleSandbox);

        const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
        const turnParams = turnStartRequest?.params as {
          approvalPolicy?: unknown;
          sandboxPolicy?: { type?: unknown };
        } | undefined;
        expect(turnParams?.approvalPolicy).toBe(scenario.approvalPolicy);
        expect(turnParams?.sandboxPolicy?.type).toBe(scenario.turnSandboxType);
      }
    });

    it("keeps the requested Codex reasoning effort while applying effective thread policy", async () => {
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-effective-start" },
        approvalPolicy: "onFailure",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        reasoningEffort: "high",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const threadStartParams = threadStartRequest?.params as {
        config?: { model_reasoning_effort?: unknown };
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
      } | undefined;
      expect(threadStartParams?.config?.model_reasoning_effort).toBe("xhigh");
      expect(threadStartParams?.effort).toBeUndefined();
      expect(threadStartParams?.reasoningEffort).toBeUndefined();
      expect(threadStartParams?.reasoning_effort).toBeUndefined();
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("on-failure");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(turnStartParams?.effort).toBe("xhigh");
      expect(turnStartParams?.reasoningEffort).toBeUndefined();
      expect(turnStartParams?.reasoning_effort).toBeUndefined();

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.codexApprovalPolicy).toBe("on-failure");
      expect(summary?.codexSandbox).toBe("workspace-write");
      expect(summary?.permissionMode).toBe("default");
      expect(summary?.reasoningEffort).toBe("xhigh");

      const persisted = readPersistedChatState(session.id);
      expect(persisted.codexApprovalPolicy).toBe("on-failure");
      expect(persisted.codexSandbox).toBe("workspace-write");
      expect(persisted.reasoningEffort).toBe("xhigh");
    });

    it("applies fresh Codex thread effective sandbox when it differs from requested flags", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "default") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-effective-start-readonly" },
        approvalPolicy: "onRequest",
        sandbox: "read-only",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "default",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const threadStartParams = threadStartRequest?.params as { approvalPolicy?: unknown; sandbox?: unknown } | undefined;
      expect(threadStartParams?.approvalPolicy).toBe("on-request");
      expect(threadStartParams?.sandbox).toBe("workspace-write");

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("on-request");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("readOnly");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.codexApprovalPolicy).toBe("on-request");
      expect(summary?.codexSandbox).toBe("read-only");
      expect(summary?.permissionMode).toBe("plan");
    });

    it("re-resumes Codex threads when permission mode changes mid-session", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Read the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      mockState.codexRequestPayloads = [];
      mockState.codexResponseOverrides.set("thread/resume", () => ({
        thread: { id: "thread-after-mode-switch" },
        approvalPolicy: "onRequest",
        sandbox: "read-only",
      }));

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Now make the needed changes.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadResumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const params = threadResumeRequest?.params as {
        approvalPolicy?: unknown;
        sandbox?: unknown;
        reasoningEffort?: unknown;
        effort?: unknown;
        config?: { model_reasoning_effort?: unknown };
      } | undefined;
      expect(params?.approvalPolicy).toBe("never");
      expect(params?.sandbox).toBe("danger-full-access");
      expect(params?.config?.model_reasoning_effort).toBe("medium");
      expect(params?.effort).toBeUndefined();
      expect(params?.reasoningEffort).toBeUndefined();

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        collaborationMode?: { mode?: unknown };
        effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("never");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("dangerFullAccess");
      expect(turnStartParams?.collaborationMode?.mode).toBe("default");
      expect(turnStartParams?.effort).toBe("medium");
    });

    it("auto-approves pending Codex approvals when switched to full-auto during an active turn", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "edit",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-switch-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-switch-1",
          turnId: "  turn-1  ",
          command: "/bin/zsh -lc 'npm test'",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-switch-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-switch-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              write: [path.join(tmpRoot, "generated.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-switch-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-switch-1"
        )).toBe(true);
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-switch-1")).toMatchObject({
          result: { decision: "accept" },
        });
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-switch-1")).toMatchObject({
          result: {
            permissions: {
              fileSystem: {
                write: [path.join(tmpRoot, "generated.txt")],
              },
            },
            scope: "turn",
          },
        });
        expect(events.some((event) =>
          event.event.type === "pending_input_resolved"
          && event.event.itemId === "cmd-switch-1"
          && event.event.resolution === "accepted"
          && event.event.turnId === "turn-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "pending_input_resolved"
          && event.event.itemId === "perm-switch-1"
          && event.event.resolution === "accepted"
          && event.event.turnId === "turn-1"
        )).toBe(true);
      });

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("full-auto");
      expect(summary?.codexApprovalPolicy).toBe("never");
      expect(summary?.codexSandbox).toBe("danger-full-access");
    });

    it("keeps escaped Codex command and file-change approvals manual in full-auto", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.codexRequestPayloads = [];

      const outsideLane = path.dirname(tmpRoot);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          command: "/bin/zsh -lc 'pwd'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-additional-perms-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-additional-perms-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          command: "/bin/zsh -lc 'cat /tmp/escape.txt'",
          additionalPermissions: {
            fileSystem: {
              read: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-additional-perms-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-additional-perms-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "file-escape-1",
        method: "item/fileChange/requestApproval",
        params: {
          itemId: "file-escape-1",
          turnId: "turn-1",
          grantRoot: outsideLane,
          reason: "Edit outside the lane",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "file-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "file-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              write: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-project-roots-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-project-roots-escape-1",
          turnId: "turn-1",
          cwd: path.join(tmpRoot, "src"),
          permissions: {
            fileSystem: {
              entries: [{
                access: "write",
                path: {
                  type: "special",
                  value: {
                    kind: "project_roots",
                    subpath: "..",
                  },
                },
              }],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-project-roots-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-project-roots-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-project-roots-whole-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-project-roots-whole-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              entries: [{
                access: "write",
                path: {
                  type: "special",
                  value: {
                    kind: "project_roots",
                  },
                },
              }],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-project-roots-whole-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-project-roots-whole-1")).toBeUndefined();
    });

    it("keeps escaped pending Codex approvals manual when switched to full-auto", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "edit",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.codexRequestPayloads = [];

      const outsideLane = path.dirname(tmpRoot);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-pending-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-pending-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          command: "/bin/zsh -lc 'pwd'",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "file-pending-escape-1",
        method: "item/fileChange/requestApproval",
        params: {
          itemId: "file-pending-escape-1",
          turnId: "turn-1",
          grantRoot: outsideLane,
          reason: "Edit outside the lane",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-pending-additional-perms-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-pending-additional-perms-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          command: "/bin/zsh -lc 'cat /tmp/escape.txt'",
          additionalPermissions: {
            fileSystem: {
              read: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-pending-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-pending-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          permissions: {
            fileSystem: {
              write: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-pending-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "file-pending-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-pending-additional-perms-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-pending-escape-1"
        )).toBe(true);
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-pending-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "file-pending-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-pending-additional-perms-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-pending-escape-1")).toBeUndefined();
      expect(events.some((event) =>
        event.event.type === "pending_input_resolved"
        && (
          event.event.itemId === "cmd-pending-escape-1"
          || event.event.itemId === "file-pending-escape-1"
          || event.event.itemId === "cmd-pending-additional-perms-escape-1"
          || event.event.itemId === "perm-pending-escape-1"
        )
      )).toBe(false);

      await service.respondToInput({
        sessionId: session.id,
        itemId: "cmd-pending-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "file-pending-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "cmd-pending-additional-perms-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "perm-pending-escape-1",
        decision: "decline",
      });
    });

    it("keeps Codex planner approval guard scoped to the turn that started in plan mode", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the investigation.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-1",
          },
        },
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-plan-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-plan-1",
          turnId: "turn-1",
          command: "/bin/zsh -lc 'ade --socket lanes list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "error"
          && event.event.turnId === "turn-1"
          && event.event.message.includes("PLANNER CONTRACT VIOLATION")
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-plan-1")).toMatchObject({
        result: { decision: "decline" },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-plan-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-plan-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          reason: "Allow write access",
          permissions: {
            fileSystem: {
              write: [path.join(tmpRoot, "planned-edit.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-plan-1")).toMatchObject({
          result: {
            permissions: {},
            scope: "turn",
          },
        });
      });
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "perm-plan-1"
      )).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({
        sessionId: session.id,
        text: "Now inspect with the updated permissions.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-full-auto-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-full-auto-1",
          turnId: "turn-2",
          command: "/bin/zsh -lc 'ade --socket chat list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-full-auto-1")).toMatchObject({
          result: { decision: "accept" },
        });
      });
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "cmd-full-auto-1"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "error"
        && event.event.turnId === "turn-2"
        && event.event.message.includes("PLANNER CONTRACT VIOLATION")
      )).toBe(false);
    });

    it("carries Codex planner approval guard through async turn/started when turn/start has no id", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      mockState.codexResponseOverrides.set("turn/start", { turn: {} });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the investigation.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {},
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-async-1",
          },
        },
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-plan-async-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-plan-async-1",
          turnId: "turn-async-1",
          command: "/bin/zsh -lc 'ade --socket lanes list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "error"
          && event.event.turnId === "turn-async-1"
          && event.event.message.includes("PLANNER CONTRACT VIOLATION")
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-plan-async-1")).toMatchObject({
        result: { decision: "decline" },
      });
    });

    it("uses each updated Codex reasoning effort on the next post-turn send", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });

      const completeLatestTurn = async (): Promise<void> => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            turn: {
              id: `turn-${mockState.codexTurnCounter}`,
              status: "completed",
            },
          },
        });
        await vi.waitFor(async () => {
          expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
        });
      };

      await service.sendMessage({
        sessionId: session.id,
        text: "Initial turn.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      await completeLatestTurn();

      for (const effort of ["low", "medium", "high", "xhigh", "ultra"]) {
        await service.updateSession({
          sessionId: session.id,
          reasoningEffort: effort,
        });
        mockState.codexRequestPayloads = [];

        await service.sendMessage({
          sessionId: session.id,
          text: `Use ${effort} reasoning now.`,
        });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        });
        const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
        expect((turnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe(effort);
        await completeLatestTurn();
      }
    });

    it("applies Codex reasoning effort changes made during an active turn to the next turn", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "low",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start with low reasoning.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const firstTurnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((firstTurnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe("low");

      await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "xhigh",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: `turn-${mockState.codexTurnCounter}`,
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "Now use the updated reasoning.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const secondTurnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((secondTurnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe("xhigh");
    });

    it("re-resumes Codex threads when switching from config-toml to full-auto flags", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexConfigSource: "config-toml",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      const startRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const startParams = startRequest?.params as Record<string, unknown> | undefined;
      expect(startParams?.approvalPolicy).toBeUndefined();
      expect(startParams?.sandbox).toBeUndefined();

      const startTurnRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const startTurnParams = startTurnRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: unknown;
      } | undefined;
      expect(startTurnParams?.approvalPolicy).toBeUndefined();
      expect(startTurnParams?.sandboxPolicy).toBeUndefined();

      mockState.codexRequestPayloads = [];

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Now make the needed changes.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const resumeParams = resumeRequest?.params as { approvalPolicy?: unknown; sandbox?: unknown } | undefined;
      expect(resumeParams?.approvalPolicy).toBe("never");
      expect(resumeParams?.sandbox).toBe("danger-full-access");
    });

    it("does not auto-upgrade default Codex chats into plan mode", async () => {
      mockState.codexCollaborationModes = [{ mode: "plan" }];
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      expect(params?.collaborationMode).toBeUndefined();
    });

    it("falls back to default collaboration mode when plan is not advertised", async () => {
      mockState.codexCollaborationModes = [{ mode: "default" }];
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
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "collaborationMode/list")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      const collaborationMode = params?.collaborationMode as { mode?: unknown } | undefined;

      expect(collaborationMode?.mode).toBe("default");
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.codexEffectiveCollaborationMode).toBe("default");
      });
      expect(events.some(({ event }) =>
        event.type === "session_meta_updated" && event.codexEffectiveCollaborationMode === "default",
      )).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Resume and error recovery
  // --------------------------------------------------------------------------
});
