import {
  AgentChatEventEnvelope,
  beginIdentityConfirmHold,
  buildCodingAgentSystemPrompt,
  claudeSdkCreateSessionCompat,
  createAgentChatService,
  createDynamicOpenCodeModelDescriptor,
  createService,
  cursorModelsListMock,
  fs,
  mapPermissionToClaude,
  mapPermissionToCodex,
  mockState,
  path,
  probeOpenCodeProviderInventory,
  query,
  readPersistedChatState,
  replaceDynamicOpenCodeModelDescriptors,
  tmpRoot,
  waitFor,
  waitForEvent,
} from "./agentChatService.testHarness";
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
  });

  describe("Claude plan mode", () => {
    it("switches the Claude SDK session into plan mode before a plan turn", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
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

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan ready" }],
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
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan ready");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("does not reapply unchanged Claude permission controls during session updates", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-stable-permission",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Ready" }],
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
        sessionId: "sdk-session-stable-permission",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "bypassPermissions",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Confirm readiness.",
      });
      expect(setPermissionMode).toHaveBeenCalledWith("bypassPermissions");

      setPermissionMode.mockClear();
      const updated = await service.updateSession({
        sessionId: session.id,
        claudePermissionMode: "bypassPermissions",
      });

      expect(updated.claudePermissionMode).toBe("bypassPermissions");
      expect(setPermissionMode).not.toHaveBeenCalled();
    });

    it("uses Claude SDK query controls for plan mode when the wrapper lacks setPermissionMode", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-query-plan",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan via query control" }],
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
        sessionId: "sdk-session-query-plan",
        query: {
          setPermissionMode,
        },
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan via query control");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("shows a plan approval card even when the session is in bypassPermissions", async () => {
      // The reported bug: a full-auto / bypassPermissions session entered plan
      // mode, and ExitPlanMode auto-approved 13ms later with no card ever
      // rendered — because the gate read the access mode, which entering plan
      // mode had left on "bypassPermissions".
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let service: ReturnType<typeof createService>["service"];
      let sessionId = "";
      let sawApprovalCard = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-plan-bypass",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan-bypass",
        });

        const entered = await service.getSessionSummary(sessionId);
        // Genuinely in plan mode — nothing still reads as bypass.
        expect(entered?.claudePermissionMode).toBe("plan");
        expect(entered?.permissionMode).toBe("plan");

        const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
          planDescription: "Plan that must be approved, not auto-accepted.",
        }, {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-plan-bypass",
        });

        const approvalEvent = await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope & {
            event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
          } =>
            event.event.type === "approval_request"
            && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
        );
        sawApprovalCard = true;

        await service.approveToolUse({
          sessionId,
          itemId: approvalEvent.event.itemId,
          decision: "accept",
        });
        await exitPromise;

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Approved by a human." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-plan-bypass",
        setPermissionMode,
      } as any);

      ({ service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      }));

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        permissionMode: "full-auto",
        claudePermissionMode: "bypassPermissions",
      });
      sessionId = session.id;

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Plan something, then exit plan mode.",
      });

      expect(sawApprovalCard).toBe(true);
      // Leaving plan mode puts the session back where it was.
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.claudePermissionMode).toBe("bypassPermissions");
      expect(summary?.permissionMode).toBe("full-auto");
    });

    it("fences a mutating tool call in plan mode even when bypass sits underneath", async () => {
      // A full-auto session that entered plan mode still has bypass as its
      // access mode. The CLI handles most plan-mode enforcement itself, but a
      // deferred mutating call reaches canUseTool — and a host that answers
      // `allow` silently lifts the fence the session just raised. The fence is
      // an allowlist, so a Windows shell and a mutating MCP tool are refused
      // even though neither name matches the legacy mutating heuristic.
      const events: AgentChatEventEnvelope[] = [];
      let enterResult: Record<string, unknown> | undefined;
      let writeResult: Record<string, unknown> | undefined;
      let readResult: Record<string, unknown> | undefined;
      let powershellResult: Record<string, unknown> | undefined;
      let mcpDeleteResult: Record<string, unknown> | undefined;
      let agentResult: Record<string, unknown> | undefined;
      let streamCall = 0;
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-plan-fence",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        const options = { signal: new AbortController().signal };
        enterResult = await sessionOpts.canUseTool("EnterPlanMode", {}, {
          ...options,
          toolUseID: "tool-plan-fence-enter",
        });
        writeResult = await sessionOpts.canUseTool(
          "Write",
          { file_path: "src/app.ts", content: "x" },
          { ...options, toolUseID: "tool-plan-fence-write" },
        );
        powershellResult = await sessionOpts.canUseTool(
          "PowerShell",
          { command: "Remove-Item -Recurse ./build" },
          { ...options, toolUseID: "tool-plan-fence-powershell" },
        );
        mcpDeleteResult = await sessionOpts.canUseTool(
          "mcp__filesystem__delete_file",
          { path: "src/app.ts" },
          {
            ...options,
            toolUseID: "tool-plan-fence-mcp",
            mcpServer: { name: "filesystem", source: "user" },
          },
        );
        agentResult = await sessionOpts.canUseTool(
          "Agent",
          { description: "explore", prompt: "find the entry point" },
          { ...options, toolUseID: "tool-plan-fence-agent" },
        );
        readResult = await sessionOpts.canUseTool(
          "Read",
          { file_path: "src/app.ts" },
          { ...options, toolUseID: "tool-plan-fence-read" },
        );

        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-plan-fence",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        permissionMode: "full-auto",
        claudePermissionMode: "bypassPermissions",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Plan, then try to write before exiting plan mode.",
      });

      expect(enterResult).toMatchObject({ behavior: "allow" });
      expect(writeResult).toMatchObject({ behavior: "deny" });
      expect(powershellResult).toMatchObject({ behavior: "deny" });
      expect(mcpDeleteResult).toMatchObject({ behavior: "deny" });
      // Subagent exploration is part of plan mode's own allowlist.
      expect(agentResult).toMatchObject({ behavior: "allow" });
      // Read-only built-ins stay usable: plan mode is inspect-only, not inert.
      expect(readResult).toMatchObject({ behavior: "allow" });
      const planned = await service.getSessionSummary(session.id);
      expect(planned?.claudePermissionMode).toBe("plan");
    });

    it("preserves Claude access overrides when entering and exiting plan mode", async () => {
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
            session_id: "sdk-session-plan-preserve",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        const enterResult = await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan",
        });
        expect(enterResult).toMatchObject({ behavior: "allow" });

        const entered = await service.getSessionSummary(sessionId);
        expect(entered?.permissionMode).toBe("plan");
        // While in plan mode the access mode is "plan" too. It used to stay on
        // the pre-plan value, which is what let a bypassPermissions session
        // auto-approve its own plan and kept the composer chip on Bypass. The
        // pre-plan mode is stashed and restored on exit (asserted below).
        expect(entered?.claudePermissionMode).toBe("plan");

        const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
          planDescription: "Ship the approved Claude changes.",
        }, {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-plan",
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

        const exitResult = await exitPromise;
        expect(exitResult).toMatchObject({
          behavior: "allow",
        });

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan approved and preserved." }],
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
        sessionId: "sdk-session-plan-preserve",
        setPermissionMode,
      } as any);

      ({ service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      }));

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        permissionMode: "edit",
        claudePermissionMode: "acceptEdits",
      });
      sessionId = session.id;

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Enter plan mode, then exit it after approval.",
      });

      expect(result.outputText).toContain("Plan approved and preserved.");
      expect(setPermissionMode).toHaveBeenCalledWith("acceptEdits");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("edit");
      expect(summary?.claudePermissionMode).toBe("acceptEdits");
    });

    it("syncs session permissionMode and emits a plan-mode notice when the SDK status message reports a transition", async () => {
      // The Claude Agent SDK handles EnterPlanMode/ExitPlanMode internally in
      // the bundled `claude` binary and signals the host via an SDKStatusMessage
      // (type: "system", subtype: "status") carrying the new permissionMode.
      // ADE must update its session state and emit the standard plan-mode
      // notice from this branch — without it, the renderer's prompt-box
      // permission badge never reflects the SDK-side transition.
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
            session_id: "sdk-session-status-plan",
            slash_commands: [],
          };
          return;
        }

        // SDK reports the internal EnterPlanMode transition via a status
        // message instead of routing through canUseTool.
        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "plan",
        };

        // SDK later reports ExitPlanMode the same way.
        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
        };

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan flow completed via status." }],
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
        sessionId: "sdk-session-status-plan",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Drive plan mode via status messages.",
      });

      const planTransitionNotices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice"
          && (event.detail as { permissionModeTransition?: string } | undefined)?.permissionModeTransition !== undefined,
        );
      expect(planTransitionNotices.map((notice) =>
        (notice.detail as { permissionModeTransition: string }).permissionModeTransition,
      )).toEqual(["entered_plan_mode", "exited_plan_mode"]);

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).not.toBe("plan");
    });

    it("ignores SDK status messages whose permissionMode matches the session's current mode", async () => {
      // Status messages can arrive frequently. Only the transitions should
      // emit notices — a redundant `permissionMode: "default"` while the
      // session is already in a non-plan mode must be a no-op.
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
            session_id: "sdk-session-status-noop",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
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
        sessionId: "sdk-session-status-noop",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Status message must not spuriously toggle plan mode.",
      });

      const planTransitionNotices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice"
          && (event.detail as { permissionModeTransition?: string } | undefined)?.permissionModeTransition !== undefined,
        );
      expect(planTransitionNotices).toHaveLength(0);
    });
  });
});


describe("Claude plan intent at query launch", () => {
  /**
   * A Claude query launched while the session still carries the plan sentinel
   * Claude set itself (EnterPlanMode) gets no activity-report instruction, even
   * when the send that launches it asks for default mode. The plan intent has
   * to be read before option building normalizes the sentinel away.
   */
  it.each([
    ["a chat that never entered plan mode", false, true],
    ["a default-mode send after Claude entered plan mode itself", true, false],
  ])("activity guidance for %s", async (_label, enterPlanFirst, expectGuidance) => {
    const cliPath = path.join(tmpRoot, "activity-cli", "ade");
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(cliPath, 0o755);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "system", subtype: "init", session_id: "sdk-plan-intent", slash_commands: [] };
        return;
      }
      if (enterPlanFirst && streamCall === 2) {
        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan-intent",
        });
      }
      yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
    })());
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      stream,
      close: vi.fn(),
      sessionId: "sdk-plan-intent",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);
    const { service } = createService({
      runtimeSocketPath: "/Users/admin/.ade-beta/sock/ade.sock",
      getAdeCliAgentEnv: () => ({ PATH: path.dirname(cliPath), ADE_CLI_PATH: cliPath }),
    });
    const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

    await service.runSessionTurn({ sessionId: session.id, text: "Look around first." });
    // Stop drops the live query, so the next send launches a fresh one.
    await service.interrupt({ sessionId: session.id });
    vi.mocked(buildCodingAgentSystemPrompt).mockClear();
    await service.sendMessage({ sessionId: session.id, text: "Now go.", interactionMode: "default" }, { awaitDispatch: true });
    const claudePrompts = () => vi.mocked(buildCodingAgentSystemPrompt).mock.calls
      .map(([args]) => args)
      .filter((args) => args.runtime === "claude-agent-sdk-query");
    await vi.waitFor(() => expect(claudePrompts().length).toBeGreaterThan(0));
    const guidance = claudePrompts().at(-1)?.sessionActivityGuidance;
    if (expectGuidance) {
      expect(guidance).toContain(`chat activity debugging --session '${session.id}'`);
    } else {
      expect(guidance).toBeNull();
    }
    await service.dispose({ sessionId: session.id });
  });
});


describe("leaving plan mode keeps a held CTO confirm-first", () => {
  /**
   * A voice call holds the CTO in confirm-first ("default") mode. Leaving plan
   * mode restores whatever access the session had before it — for the CTO,
   * bypass — so every exit has to re-assert the identity policy, or one exit
   * hands the call write access without a spoken confirmation.
   */
  type ExitContext = {
    service: ReturnType<typeof createService>["service"];
    sessionId: string;
    sessionOpts: any;
    events: AgentChatEventEnvelope[];
  };
  type ExitPath = {
    /** How the session got into plan mode. */
    enterVia: "EnterPlanMode" | "plan-mode send";
    /** Leaves plan mode; returns SDK messages the stream should yield. */
    exit: (ctx: ExitContext) => Promise<unknown[]>;
  };

  const approveExitPlanMode = async ({ service, sessionId, sessionOpts, events }: ExitContext) => {
    const exitPromise = sessionOpts.canUseTool("ExitPlanMode", { planDescription: "Ship it." }, {
      signal: new AbortController().signal,
      toolUseID: "tool-exit-plan-held",
    });
    const card = await Promise.race([
      waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request"
          && (event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval",
      ),
      // The stale-session branch answers without a card.
      exitPromise.then(() => null),
    ]);
    if (card) await service.approveToolUse({ sessionId, itemId: card.event.itemId, decision: "accept" });
    await exitPromise;
    return [];
  };

  it.each<[string, ExitPath]>([
    ["approving ExitPlanMode", { enterVia: "EnterPlanMode", exit: approveExitPlanMode }],
    ["the SDK reporting it left plan mode", {
      enterVia: "EnterPlanMode",
      exit: async () => [{ type: "system", subtype: "status", status: null, permissionMode: "default" }],
    }],
    ["ExitPlanMode auto-approved for a session with bypass underneath", {
      enterVia: "plan-mode send",
      exit: approveExitPlanMode,
    }],
    ["the user switching the mode back", {
      enterVia: "EnterPlanMode",
      exit: async ({ service, sessionId }) => {
        await service.updateSession({ sessionId, permissionMode: "full-auto" });
        return [];
      },
    }],
  ])("stays confirm-first after %s", async (_label, path) => {
    vi.mocked(mapPermissionToClaude).mockImplementation((mode) => {
      if (mode === "full-auto") return "bypassPermissions";
      if (mode === "edit") return "acceptEdits";
      if (mode === "default") return "default";
      return "plan";
    });
    const events: AgentChatEventEnvelope[] = [];
    let service!: ReturnType<typeof createService>["service"];
    let sessionId = "";
    let release: (() => void) | null = null;
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "system", subtype: "init", session_id: "sdk-held-cto", slash_commands: [] };
        return;
      }
      const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
      if (path.enterVia === "EnterPlanMode") {
        await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan-held",
        });
      }
      expect((await service.getSessionSummary(sessionId))?.permissionMode).toBe("plan");
      // The call starts while the CTO is planning.
      release = beginIdentityConfirmHold(sessionId);
      for (const message of await path.exit({ service, sessionId, sessionOpts, events })) yield message;
      yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
    })());
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      stream,
      close: vi.fn(),
      sessionId: "sdk-held-cto",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    try {
      ({ service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) }));
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
        identityKey: "cto",
      });
      sessionId = session.id;
      expect(session.permissionMode).toBe("full-auto");

      await service.sendMessage({
        sessionId,
        text: "Plan the change.",
        ...(path.enterVia === "plan-mode send" ? { interactionMode: "plan" as const } : {}),
      }, { awaitDispatch: true });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "done" && event.sessionId === sessionId);

      const after = await service.getSessionSummary(sessionId);
      expect(release).not.toBeNull();
      expect(after?.interactionMode).toBe("default");
      expect(after?.permissionMode).toBe("default");
      expect(after?.claudePermissionMode).toBe("default");
    } finally {
      (release as (() => void) | null)?.();
      vi.mocked(mapPermissionToClaude).mockImplementation(() => "plan" as const);
      await service?.dispose({ sessionId });
    }
  });
});

describe("Codex async questions", () => {
  const emitAsyncQuestion = (itemId: string, questions: unknown[]): void => {
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: {
          id: itemId,
          type: "agentMessage",
          threadId: "thread-1",
          delivery: "async",
          questions,
        },
      },
    });
  };

  const startCodexChat = async (events: AgentChatEventEnvelope[]) => {
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
      text: "Start working.",
    }, { awaitDispatch: true });
    return { service, session };
  };

  it("raises a card instead of rendering the question as assistant prose", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { session } = await startCodexChat(events);
    emitAsyncQuestion("codex-async-1", [
      { title: "Postgres or SQLite?", options: ["Postgres", "SQLite"] },
      { title: "Ship today?", options: null },
    ]);

    const card = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-async-1",
    );
    const request = (card.event as { detail?: { request?: any } }).detail?.request;
    expect(request.blocking).toBe(false);
    expect(request.canProceedWithoutAnswer).toBe(true);
    expect(request.title).toBe("Codex has a question");
    expect(request.providerMetadata).toMatchObject({ responseMode: "message", dismissible: true });
    expect(request.questions.map((q: any) => q.id)).toEqual(["0", "1"]);
    expect(request.questions[0].question).toBe("Postgres or SQLite?");
    expect(request.questions[0].options.map((o: any) => o.label)).toEqual(["Postgres", "SQLite"]);
    // Free text is always accepted on this shape; there is no "other" flag.
    expect(request.questions[1].allowsFreeform).toBe(true);
    expect(request.questions[1].options).toEqual([]);
    // The question must never also reach the transcript as prose.
    expect(events.some((entry) =>
      entry.event.type === "text" && entry.sessionId === session.id
      && String((entry.event as { text?: string }).text ?? "").includes("Postgres or SQLite?"),
    )).toBe(false);
  });

  it("leaves the composer usable and the row un-blocked", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service, session } = await startCodexChat(events);
    emitAsyncQuestion("codex-async-2", [{ title: "Keep going?", options: ["Yes"] }]);
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-async-2",
    );

    const summary = await service.getSessionSummary(session.id);
    expect(summary?.awaitingInput).toBeUndefined();
    expect(summary?.pendingInputItemId).toBeUndefined();
    expect(summary?.asyncQuestion).toBe(true);
    // Never persisted as a block — the durable record is the banked question.
    expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
    expect(readPersistedChatState(session.id).asyncQuestions).toHaveLength(1);
  });

  it("answers by sending an ordinary message and writes an accepted receipt", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service, session } = await startCodexChat(events);
    emitAsyncQuestion("codex-async-3", [{ title: "Postgres or SQLite?", options: ["Postgres"] }]);
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-async-3",
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: "codex-async-3",
      decision: "accept",
      answers: { "0": "Postgres" },
    });

    const receipt = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "pending_input_resolved" && event.event.itemId === "codex-async-3",
    );
    expect((receipt.event as { resolution?: string }).resolution).toBe("accepted");
    const userMessage = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "user_message"
        && String((event.event as { text?: string }).text ?? "").includes("Postgres or SQLite?"),
    );
    expect((userMessage.event as { text?: string }).text).toContain("Postgres");
    expect(readPersistedChatState(session.id).asyncQuestions).toBeUndefined();
  });

  it("keeps an async card and markers when its answer cannot be dispatched", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service, session } = await startCodexChat(events);
    emitAsyncQuestion("codex-async-live-pending", [{ title: "Keep going?", options: ["Yes"] }]);
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-async-live-pending",
    );

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "codex-blocking-request",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-blocking-request",
        questions: [{ id: "q", question: "Approve this command?", options: [{ label: "Allow" }] }],
      },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-blocking-request",
    );

    await expect(service.respondToInput({
      sessionId: session.id,
      itemId: "codex-async-live-pending",
      decision: "accept",
      answers: { "0": "Yes" },
    })).rejects.toThrow(/pending input/i);

    expect(events.some((event) =>
      event.event.type === "pending_input_resolved"
      && event.event.itemId === "codex-async-live-pending",
    )).toBe(false);
    expect((await service.getSessionSummary(session.id))?.asyncQuestion).toBe(true);
    expect(readPersistedChatState(session.id).asyncQuestions).toHaveLength(1);

    await service.respondToInput({
      sessionId: session.id,
      itemId: "codex-blocking-request",
      decision: "decline",
    });
  });

  it("dismisses with a receipt and a notice, and stops banking the card", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service, session } = await startCodexChat(events);
    emitAsyncQuestion("codex-async-4", [{ title: "Keep going?", options: ["Yes"] }]);
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-async-4",
    );

    await service.dismissPendingInput({ sessionId: session.id, itemId: "codex-async-4" });

    const receipt = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "pending_input_resolved" && event.event.itemId === "codex-async-4",
    );
    expect((receipt.event as { resolution?: string }).resolution).toBe("cancelled");
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "system_notice"
        && (event.event as { message?: string }).message === "Question dismissed",
    );
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.asyncQuestion).toBeUndefined();
    expect(readPersistedChatState(session.id).asyncQuestions).toBeUndefined();
  });

  it("refuses to dismiss a card the provider is waiting on", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service, session } = await startCodexChat(events);
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "blocking-question-1",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-blocking-1",
        questions: [{ id: "q", question: "Approve this command?", options: [{ label: "Allow" }] }],
      },
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-blocking-1",
    );

    await expect(
      service.dismissPendingInput({ sessionId: session.id, itemId: "codex-blocking-1" }),
    ).rejects.toThrow("This question needs an answer. Answer it or stop the turn.");
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.awaitingInput).toBe(true);
    expect(summary?.pendingInputItemId).toBe("codex-blocking-1");
  });

  it("keeps an unanswered card in history regardless of the event window", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service, session } = await startCodexChat(events);
    emitAsyncQuestion("codex-async-5", [{ title: "Keep going?", options: ["Yes"] }]);
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request" && event.event.itemId === "codex-async-5",
    );
    for (let index = 0; index < 5; index += 1) {
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: `codex-cmd-${index}`,
            type: "commandExecution",
            command: `echo noise-${index}`,
            status: "completed",
          },
        },
      });
    }
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "command"
        && String((event.event as { command?: string }).command ?? "").includes("noise-4"),
    );

    const history = await service.getChatEventHistory(session.id, { maxEvents: 2 });
    expect(history.events.some((entry) =>
      entry.event.type === "approval_request" && entry.event.itemId === "codex-async-5",
    )).toBe(true);
  });
});
