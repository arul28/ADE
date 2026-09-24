import {
  AgentChatEventEnvelope,
  PendingInputRequest,
  SESSION_STALE_AFTER_MS,
  acquireCursorSdkConnection,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createChatRuntimeBudget,
  createService,
  fs,
  getSessionInfo,
  getSessionMessages,
  gzipSync,
  mockState,
  openClaudeApprovalHarness,
  parkCursorSend,
  parseAgentChatTranscript,
  path,
  query,
  readPersistedChatState,
  spawn,
  startOpenCodeSession,
  streamText,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  waitForCondition,
  waitForEvent,
  waitForSessionTitle,
  writePersistedChatState,
} from "./agentChatServiceTestFixture";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("Claude SessionStore reads", () => {
    it("maps SDK messages and forwards paging plus system-message options", async () => {
      const { service } = createService();
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "assistant",
        uuid: "wire-1",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        parent_agent_id: "parent-agent-1",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "SDK transcript text" }],
        },
      }] as any);

      await expect(service.getClaudeSessionMessages({
        sessionId: "sdk-session-1",
        laneId: "lane-1",
        limit: 25,
        offset: 3,
        includeSystemMessages: true,
      })).resolves.toEqual([expect.objectContaining({
        uuid: "wire-1",
        sessionId: "sdk-session-1",
        parentAgentId: "parent-agent-1",
        text: "SDK transcript text",
      })]);
      expect(getSessionMessages).toHaveBeenCalledWith("sdk-session-1", {
        dir: fs.realpathSync(tmpRoot),
        limit: 25,
        offset: 3,
        includeSystemMessages: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  // listSubagents
  // --------------------------------------------------------------------------

  describe("listSubagents", () => {
    it("returns empty array when no subagents are tracked", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const subagents = await service.listSubagents({ sessionId: session.id });
      expect(subagents).toEqual([]);
    });

    it("returns empty array for unknown session", async () => {
      const { service } = createService();
      const subagents = await service.listSubagents({ sessionId: "unknown-id" });
      expect(subagents).toEqual([]);
    });

    it("hydrates stopped subagents from the persisted chat transcript", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const transcriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      const placeholderStarted: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "call-spawn-1",
          parentToolUseId: "call-spawn-1",
          description: "Inspect the shared chat renderer",
          turnId: "turn-1",
        },
      };
      const agentStarted: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:00:01.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-thread-1",
          agentId: "agent-thread-1",
          agentType: "Sagan",
          parentToolUseId: "call-spawn-1",
          description: "Inspect the shared chat renderer",
          turnId: "turn-1",
        },
      };
      const stopped: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:02:00.000Z",
        event: {
          type: "subagent_result",
          taskId: "agent-thread-1",
          agentId: "agent-thread-1",
          agentType: "Sagan",
          parentToolUseId: "call-spawn-1",
          status: "stopped",
          summary: "Halted by parent turn.",
          turnId: "turn-1",
        },
      };
      fs.writeFileSync(
        transcriptFile,
        `${JSON.stringify(placeholderStarted)}\n${JSON.stringify(agentStarted)}\n${JSON.stringify(stopped)}\n`,
        "utf8",
      );

      const subagents = await service.listSubagents({ sessionId: session.id });

      expect(subagents).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          agentId: "agent-thread-1",
          agentType: "Sagan",
          parentToolUseId: "call-spawn-1",
          description: "Inspect the shared chat renderer",
          status: "stopped",
          summary: "Halted by parent turn.",
          endTimestamp: "2026-06-30T01:02:00.000Z",
        }),
      ]);
    });

    it("caps persisted subagent lifecycle hydration to the newest 1,000 rows", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const transcriptFile = path.join(
        tmpRoot,
        ".ade",
        "transcripts",
        "chat",
        `${session.id}.jsonl`,
      );
      const rows = Array.from({ length: 1_200 }, (_, index): AgentChatEventEnvelope => ({
        sessionId: session.id,
        timestamp: new Date(Date.UTC(2026, 6, 24, 12, 0, index)).toISOString(),
        sequence: index,
        event: {
          type: "subagent_started",
          taskId: `task-${index}`,
          agentId: `agent-${index}`,
          description: `Review slice ${index}`,
          turnId: `turn-${index}`,
        },
      }));
      fs.writeFileSync(
        transcriptFile,
        `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );

      const subagents = await service.listSubagents({ sessionId: session.id });

      expect(subagents).toHaveLength(1_000);
      expect(subagents.some((entry) => entry.taskId === "task-0")).toBe(false);
      expect(subagents.some((entry) => entry.taskId === "task-1199")).toBe(true);
    });

    it("serves all viewer transcript endpoints from a large gzip without synchronous whole-file reads", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const actualTranscript = await vi.importActual<typeof import("../../../shared/chatTranscript")>("../../../shared/chatTranscript");
      vi.mocked(parseAgentChatTranscript).mockImplementation(actualTranscript.parseAgentChatTranscript);
      const transcriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      const lifecycle: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "agent-thread-gzip",
          agentId: "agent-thread-gzip",
          description: "Inspect compressed history",
        },
      };
      const captured: AgentChatEventEnvelope = {
        ...lifecycle,
        sequence: 2,
        provenance: {
          threadId: "agent-thread-gzip",
          role: "agent",
          targetKind: "codex_subagent",
        },
      };
      const recent: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:01:00.000Z",
        sequence: 3,
        event: { type: "user_message", text: "recent transcript tail" },
      };
      const oversizedButBounded: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T00:59:00.000Z",
        sequence: 0,
        event: { type: "text", text: "x".repeat(5 * 1024 * 1024) },
      };
      const compressedPath = `${transcriptFile}.gz`;
      fs.writeFileSync(compressedPath, gzipSync([
        JSON.stringify(oversizedButBounded),
        JSON.stringify(lifecycle),
        JSON.stringify(captured),
        JSON.stringify(recent),
        "",
      ].join("\n")));
      fs.rmSync(transcriptFile, { force: true });
      const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

      const [subagents, subagentTranscript, chatTranscript, transcriptEntries] = await Promise.all([
        service.listSubagents({ sessionId: session.id }),
        service.getSubagentTranscript({
          sessionId: session.id,
          agentId: "agent-thread-gzip",
        }),
        service.getChatTranscript({ sessionId: session.id }),
        service.readTranscript(session.id, 10),
      ]);

      expect(subagents).toEqual([
        expect.objectContaining({ taskId: "agent-thread-gzip", status: "running" }),
      ]);
      expect(subagentTranscript).toEqual([
        expect.objectContaining({ sessionId: "agent-thread-gzip" }),
      ]);
      expect(chatTranscript.entries.at(-1)?.text).toBe("recent transcript tail");
      expect(transcriptEntries.at(-1)?.text).toBe("recent transcript tail");
      expect(
        readFileSyncSpy.mock.calls.some(([filePath]) => filePath === compressedPath),
      ).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Claude Workflow runs (workflow_progress fan-out) + child spawn lineage
  // --------------------------------------------------------------------------

  describe("claude workflow progress fan-out", () => {
    it("fans workflow agents out as subagent rows with stable identity and closes stragglers on workflow end", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      let releaseTerminalNotification: (() => void) | null = null;
      const terminalNotificationGate = new Promise<void>((resolve) => { releaseTerminalNotification = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-wf-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "wf-1",
          description: "Run review workflow",
          task_type: "local_workflow",
          workflow_name: "review",
        };
        // Tick 1: phase + one running agent, one queued agent (no startedAt).
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-1",
          description: "Run review workflow",
          usage: { total_tokens: 100, tool_uses: 1, duration_ms: 50 },
          workflow_progress: [
            { type: "workflow_phase", index: 0, title: "Scan" },
            { type: "workflow_agent", index: 0, state: "start", startedAt: 1, label: "scan:auth", agentId: "agent-a", model: "claude-opus-5", tokens: 100 },
            { type: "workflow_agent", index: 1, state: "start", label: "scan:db" },
          ],
        };
        // Tick 2: agent-a finishes, the queued agent starts.
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-1",
          description: "Run review workflow",
          usage: { total_tokens: 900, tool_uses: 4, duration_ms: 900 },
          workflow_progress: [
            { type: "workflow_phase", index: 0, title: "Scan" },
            { type: "workflow_agent", index: 0, state: "done", startedAt: 1, label: "scan:auth", agentId: "agent-a", model: "claude-opus-5", tokens: 900, durationMs: 800 },
            { type: "workflow_agent", index: 1, state: "start", startedAt: 5, label: "scan:db" },
          ],
        };
        // Some SDK versions publish a completed patch before the richer
        // notification. The active entry must retain the latest snapshot.
        yield {
          type: "system",
          subtype: "task_updated",
          task_id: "wf-1",
          patch: { status: "completed" },
        };
        await terminalNotificationGate;
        // Workflow ends while scan:db is still running.
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "wf-1",
          status: "completed",
          summary: "workflow done",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-wf-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "Run the workflow." });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result"
          && (e.event as any).taskId === "wf-1::a1"
          && (e.event as any).status === "stopped",
      );
      releaseTerminalNotification!();
      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result" && (e.event as any).taskId === "wf-1",
      );

      const agentEvents = events.filter((e) => (e.event as any).agentId === "agent-a");
      const started = agentEvents.filter((e) => e.event.type === "subagent_started");
      const results = agentEvents.filter((e) => e.event.type === "subagent_result");
      // Stable identity: exactly one started + one result despite cumulative re-emission.
      expect(started).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect((started[0]!.event as any).taskId).toBe("wf-1::a0");
      expect((started[0]!.event as any).description).toBe("scan:auth");
      expect((started[0]!.event as any).workflowName).toBe("review");
      expect((started[0]!.event as any).model).toBe("claude-opus-5");
      expect((started[0]!.event as any).background).toBe(true);
      expect((results[0]!.event as any).status).toBe("completed");
      expect((results[0]!.event as any).usage?.totalTokens).toBe(900);

      // The queued agent only materializes once it starts, then is closed as
      // stopped when the workflow ends before it finishes.
      const dbRow = events.filter((e) => (e.event as any).taskId === "wf-1::a1");
      expect(dbRow.some((e) => e.event.type === "subagent_started")).toBe(true);
      const dbResult = dbRow.find((e) => e.event.type === "subagent_result");
      expect(dbResult?.event).toMatchObject({
        status: "stopped",
        finalSummary: "Workflow ended before this agent finished.",
        stopSource: "system",
        // The workflow reached its end; nothing crashed. This row used to read
        // "the runtime process exited" because the helper defaulted to it.
        stopReason: "the workflow ended",
      });

      // The terminal parent result carries a reconciled workflow snapshot even
      // when the SDK's last progress tick still reports an active agent.
      const parentResult = events.find(
        (e) => e.event.type === "subagent_result" && (e.event as any).taskId === "wf-1",
      );
      expect((parentResult?.event as any)?.summary).toBe("workflow done");
      expect((parentResult?.event as any)?.workflowProgress).toMatchObject({
        phases: [{ index: 0, title: "Scan" }],
        queuedCount: 0,
        runningCount: 0,
        doneCount: 1,
        agents: [
          expect.objectContaining({ status: "completed" }),
          expect.objectContaining({ status: "stopped" }),
        ],
      });
      expect((await service.listSubagents({ sessionId: session.id })).find((row) => row.taskId === "wf-1"))
        .toEqual(expect.objectContaining({
          workflowProgress: expect.objectContaining({ runningCount: 0, doneCount: 1 }),
        }));

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });
  });

  describe("child chat spawn lineage", () => {
    it("notifies the parent session with a spawn chip notice and a live subagent row", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-lineage", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-lineage",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "opus",
        title: "Fix flaky tests",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      const parentEvents = events.filter((e) => e.sessionId === parent.id);
      const notice = parentEvents.find(
        (e) => e.event.type === "system_notice" && (e.event as any).status === "subagent_spawned",
      );
      expect(notice).toBeTruthy();
      expect((notice!.event as any).message).toContain("Fix flaky tests");
      expect((notice!.event as any).detail?.spawnedSession?.sessionId).toBe(child.id);
      expect((notice!.event as any).detail?.spawnKind).toBe("subagent");

      const row = parentEvents.find(
        (e) => e.event.type === "subagent_started" && (e.event as any).taskId === `chat:${child.id}`,
      );
      expect(row).toBeTruthy();
      expect((row!.event as any).agentId).toBe(child.id);
      expect((row!.event as any).description).toBe("Fix flaky tests");
      expect((row!.event as any).spawnKind).toBe("subagent");
      expect((row!.event as any).model).toBe(child.model);
      expect(child.model).toBe("claude-opus-5-5");

      expect(child.orchestrationParentSessionId).toBe(parent.id);
      expect(child.spawnKind).toBe("subagent");
      expect(readPersistedChatState(child.id)).toMatchObject({ spawnKind: "subagent" });
      await expect(service.getSessionSummary(child.id)).resolves.toMatchObject({ spawnKind: "subagent" });
      await expect(createService().service.getSessionSummary(child.id)).resolves.toMatchObject({ spawnKind: "subagent" });
    });

    it("wakes the parent with durable turn metadata when a parent-dispatched subagent turn finishes", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-wake", slash_commands: [] };
        yield {
          type: "assistant",
          message: {
            id: "msg-spawn-summary",
            content: [{ type: "text", text: "Implemented the retry and added regression tests." }],
            usage: { input_tokens: 1, output_tokens: 8 },
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-wake",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Wake contract child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      await service.messageSession({
        sessionId: child.id,
        text: "Finish the task.",
        metadata: {
          spawnDispatch: {
            parentSessionId: parent.id,
            dispatchedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });

      await vi.waitFor(() => {
        const wake = events.find((event) =>
          event.sessionId === parent.id
          && event.event.type === "user_message"
          && (event.event.metadata as any)?.spawnCompletion?.childSessionId === child.id
        );
        expect(wake).toBeTruthy();
        expect((wake!.event as any).text).toContain("Wake contract child");
        expect((wake!.event as any).metadata.spawnCompletion).toMatchObject({
          childSessionId: child.id,
          childTitle: "Wake contract child",
          spawnKind: "subagent",
          status: "completed",
          summary: "Implemented the retry and added regression tests.",
          childTurnId: expect.any(String),
        });
        expect((wake!.event as any).text).toContain("Implemented the retry and added regression tests.");
      });

      await service.messageSession({
        sessionId: child.id,
        text: "Handle the follow-up too.",
        metadata: {
          spawnDispatch: {
            parentSessionId: parent.id,
            dispatchedAt: "2026-08-01T00:01:00.000Z",
          },
        },
      });
      await vi.waitFor(() => {
        const completions = events.filter((event) =>
          event.sessionId === parent.id
          && event.event.type === "user_message"
          && event.event.metadata?.spawnCompletion?.childSessionId === child.id
        );
        expect(completions).toHaveLength(2);
        expect(new Set(completions.map((event) =>
          event.event.type === "user_message"
            ? event.event.metadata?.spawnCompletion?.childTurnId
            : undefined
        )).size).toBe(2);
      });
    });

    it("reports a child completion into the CTO thread as one line, never a transcript dump", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-cto-spawn", slash_commands: [] };
        yield {
          type: "assistant",
          message: {
            id: "msg-cto-child",
            content: [{
              type: "text",
              text: "Landed the retry fix, rewrote the flaky helper, and opened https://github.com/ade/ade/pull/1234 with regression tests.",
            }],
            usage: { input_tokens: 1, output_tokens: 8 },
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-cto-spawn",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const cto = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Retry fix",
        orchestrationParentSessionId: cto.id,
        spawnKind: "subagent",
      });

      await service.messageSession({ sessionId: child.id, text: "Finish the task." });

      const notice = await vi.waitFor(() => {
        const found = events.find((event) =>
          event.sessionId === cto.id
          && event.event.type === "system_notice"
          && event.event.status === "spawn_completed");
        expect(found).toBeTruthy();
        return found!.event as Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }>;
      });

      // Title, provider, outcome, PR number — and nothing else. The child's
      // closing paragraph is what a coordinator thread cannot afford to carry.
      expect(notice.message).toBe('"Retry fix" · Claude · finished · PR #1234');
      expect(notice.message).not.toContain("rewrote the flaky helper");

      // The subagent_result card restates the whole summary, so the CTO thread
      // does not get one.
      expect(events.some((event) =>
        event.sessionId === cto.id && event.event.type === "subagent_result")).toBe(false);

      // The model is still told, with the same single line.
      const wake = await vi.waitFor(() => {
        const found = events.find((event) =>
          event.sessionId === cto.id
          && event.event.type === "user_message"
          && event.event.text === notice.message);
        expect(found).toBeTruthy();
        return found!;
      });
      expect((wake.event as any).metadata?.spawnCompletion).toBeUndefined();
    });

    it("wakes the parent when a human messages a subagent, and names that human message in the report", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-human", slash_commands: [] };
        yield {
          type: "assistant",
          message: {
            id: "msg-human-summary",
            content: [{ type: "text", text: "Adjusted the retry." }],
            usage: { input_tokens: 1, output_tokens: 4 },
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-human",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Human-directed child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      await service.sendMessage({ sessionId: child.id, text: "Human follow-up." });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "user_message"
          && event.event.metadata?.spawnCompletion?.childSessionId === child.id
        )).toBe(true);
      });
      const wake = events.find((event) =>
        event.sessionId === parent.id
        && event.event.type === "user_message"
        && event.event.metadata?.spawnCompletion?.childSessionId === child.id
      );
      expect(wake?.event.type === "user_message" && wake.event.metadata?.spawnCompletion?.humanMessageCount).toBe(1);
      expect(wake?.event.type === "user_message" && wake.event.metadata?.spawnCompletion?.summary).toContain(
        "The user also sent 1 message to this chat.",
      );
      expect(events.some((event) =>
        event.sessionId === parent.id
        && event.event.type === "system_notice"
        && event.event.status === "spawn_completed"
        && (event.event.detail as any)?.spawnCompletion?.childSessionId === child.id
      )).toBe(false);
    });

    it("wakes the parent when a self-scheduled wakeup finishes a turn the parent still owns", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamTurn = 0;
      const stream = vi.fn(() => (async function* () {
        streamTurn += 1;
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-scheduled", slash_commands: [] };
        yield {
          type: "assistant",
          message: {
            id: `msg-scheduled-summary-${streamTurn}`,
            content: [{ type: "text", text: "Mission complete: PR merged." }],
            usage: { input_tokens: 1, output_tokens: 6 },
          },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-scheduled",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Ship loop child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      await service.messageSession({
        sessionId: child.id,
        text: "Ship the fix.",
        metadata: {
          spawnDispatch: { parentSessionId: parent.id, dispatchedAt: "2026-08-11T00:00:00.000Z" },
        },
      });
      const parentWakes = () => events.filter((event) =>
        event.sessionId === parent.id
        && event.event.type === "user_message"
        && event.event.metadata?.spawnCompletion?.childSessionId === child.id
      );
      await vi.waitFor(() => expect(parentWakes()).toHaveLength(1));

      // The incident: the mission's final turn is started by the child's own
      // durable scheduler, not by the parent.
      await service.messageSession({
        sessionId: child.id,
        kind: "wake",
        text: "Check CI.",
        metadata: {
          scheduledWake: {
            scheduleId: "wakeup-1",
            kind: "wakeup",
            firedAt: "2026-08-11T00:10:00.000Z",
            reason: "poll CI",
          },
        },
      });

      await vi.waitFor(() => expect(parentWakes()).toHaveLength(2));
      const [dispatchedWake, scheduledWake] = parentWakes();
      expect((dispatchedWake!.event as any).metadata.spawnCompletion.summary)
        .toBe("Mission complete: PR merged.");
      expect((scheduledWake!.event as any).metadata.spawnCompletion).toMatchObject({
        childSessionId: child.id,
        childTitle: "Ship loop child",
        spawnKind: "subagent",
        status: "completed",
      });
      expect((scheduledWake!.event as any).metadata.spawnCompletion.childTurnId)
        .not.toBe((dispatchedWake!.event as any).metadata.spawnCompletion.childTurnId);
    });

    it("keeps waking the parent after a human messages a subagent, including later scheduled turns", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-handover", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-handover",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Handover child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      await service.messageSession({
        sessionId: child.id,
        text: "Ship the fix.",
        metadata: {
          spawnDispatch: { parentSessionId: parent.id, dispatchedAt: "2026-08-11T00:00:00.000Z" },
        },
      });
      const parentWakes = () => events.filter((event) =>
        event.sessionId === parent.id
        && event.event.type === "user_message"
        && event.event.metadata?.spawnCompletion?.childSessionId === child.id
      );
      const quietNotices = () => events.filter((event) =>
        event.sessionId === parent.id
        && event.event.type === "system_notice"
        && event.event.status === "spawn_completed"
        && (event.event.detail as any)?.spawnCompletion?.childSessionId === child.id
      );
      await vi.waitFor(() => expect(parentWakes()).toHaveLength(1));

      await service.sendMessage({ sessionId: child.id, text: "Actually, hold on — do this instead." });
      await vi.waitFor(() => expect(parentWakes()).toHaveLength(2));
      const secondWake = parentWakes()[1];
      expect(secondWake?.event.type === "user_message"
        && secondWake.event.metadata?.spawnCompletion?.humanMessageCount).toBe(1);

      await service.messageSession({
        sessionId: child.id,
        kind: "wake",
        text: "Check CI.",
        metadata: {
          scheduledWake: {
            scheduleId: "wakeup-2",
            kind: "wakeup",
            firedAt: "2026-08-11T00:20:00.000Z",
            reason: "poll CI",
          },
        },
      });

      await vi.waitFor(() => expect(parentWakes()).toHaveLength(3));
      expect(quietNotices()).toHaveLength(0);
    });

    it("emits a quiet completion notice without a wake when a peer finishes", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-peer", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-peer",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Quiet peer",
        orchestrationParentSessionId: parent.id,
        spawnKind: "peer",
      });

      await service.sendMessage({ sessionId: child.id, text: "Finish the task." });

      await vi.waitFor(() => {
        const completion = events.find((event) =>
          event.sessionId === parent.id
          && event.event.type === "system_notice"
          && event.event.status === "spawn_completed"
        );
        expect(completion).toBeTruthy();
        expect((completion!.event as any).detail.spawnCompletion).toMatchObject({
          childSessionId: child.id,
          childTitle: "Quiet peer",
          spawnKind: "peer",
          status: "completed",
        });
      });
      expect(events.some((event) =>
        event.sessionId === parent.id
        && event.event.type === "user_message"
        && (event.event.metadata as any)?.spawnCompletion
      )).toBe(false);
    });

    it("demotes a subagent to a peer, notes the parent, and keeps later turns quiet", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-demote", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-demote",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Review child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      const demoted = service.setSpawnKind({ sessionId: child.id, spawnKind: "peer" });
      expect(demoted.spawnKind).toBe("peer");
      expect(demoted.subagentTakeoverPromptShownAt).toBeTruthy();
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "system_notice"
          && event.event.status === "spawn_takeover"
          && (event.event.detail as any)?.spawnTakeover?.childSessionId === child.id
        )).toBe(true);
      });
      const takeover = events.find((event) =>
        event.sessionId === parent.id
        && event.event.type === "system_notice"
        && event.event.status === "spawn_takeover"
      );
      expect(takeover?.event.type === "system_notice" && takeover.event.message).toBe(
        'The user took over "Review child" — reports stop here.',
      );

      await service.sendMessage({ sessionId: child.id, text: "Keep going without the parent." });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "system_notice"
          && event.event.status === "spawn_completed"
          && (event.event.detail as any)?.spawnCompletion?.childSessionId === child.id
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.sessionId === parent.id
        && event.event.type === "user_message"
        && event.event.metadata?.spawnCompletion?.childSessionId === child.id
      )).toBe(false);
    });

    it("promotes a peer back to a subagent when the parent still exists", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-promote", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-promote",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Promoted child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "peer",
      });

      expect(service.setSpawnKind({ sessionId: child.id, spawnKind: "subagent" }).spawnKind).toBe("subagent");
      await service.sendMessage({ sessionId: child.id, text: "Report back." });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "user_message"
          && event.event.metadata?.spawnCompletion?.childSessionId === child.id
        )).toBe(true);
      });
    });

    it("refuses to promote when the parent chat is gone", async () => {
      const { service } = createService();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Orphaned child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "peer",
      });
      await service.deleteSession({ sessionId: parent.id });
      expect(() => service.setSpawnKind({ sessionId: child.id, spawnKind: "subagent" })).toThrow(
        /parent chat is gone/i,
      );
    });

    it("auto-promotes a peer back to a subagent when the parent dispatches again", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-autoped", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-autoped",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Reclaimed child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "peer",
      });

      await service.messageSession({
        sessionId: child.id,
        text: "Do this next.",
        metadata: {
          spawnDispatch: { parentSessionId: parent.id, dispatchedAt: "2026-08-12T00:00:00.000Z" },
        },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "user_message"
          && event.event.metadata?.spawnCompletion?.childSessionId === child.id
        )).toBe(true);
      });
      expect((await service.getSessionSummary(child.id))?.spawnKind).toBe("subagent");
      expect(events.some((event) =>
        event.sessionId === parent.id
        && event.event.type === "system_notice"
        && event.event.status === "spawn_takeover"
      )).toBe(false);
    });

    it("persists the takeover prompt as shown without changing spawn kind", async () => {
      const { service } = createService();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });
      const dismissed = service.dismissSubagentTakeoverPrompt({ sessionId: child.id });
      expect(dismissed.spawnKind).toBe("subagent");
      expect(dismissed.subagentTakeoverPromptShownAt).toBeTruthy();
      expect((await service.getSessionSummary(child.id))?.subagentTakeoverPromptShownAt).toBe(
        dismissed.subagentTakeoverPromptShownAt,
      );
    });

    it("converts an orphaned subagent to a peer when the parent is gone", async () => {
      const { service } = createService();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });
      await service.deleteSession({ sessionId: parent.id });

      const summary = await service.getSessionSummary(child.id);
      expect(summary?.spawnKind).toBe("peer");
      expect(summary?.orchestrationParentReachable).toBe(false);
      expect(summary?.subagentTakeoverPromptShownAt).toBeTruthy();

      const takeover = await service.updateSession({ sessionId: child.id, spawnKind: "peer" });
      expect(takeover.spawnKind).toBe("peer");
      expect(takeover.subagentTakeoverPromptShownAt).toBeTruthy();
      expect((await service.getSessionSummary(child.id))?.spawnKind).toBe("peer");
    });

    it("dismissing takeover on an orphan converts ownership and stays dismissed", async () => {
      const { service } = createService();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });
      await service.deleteSession({ sessionId: parent.id });

      const dismissed = service.dismissSubagentTakeoverPrompt({ sessionId: child.id });
      expect(dismissed.spawnKind).toBe("peer");
      expect(dismissed.subagentTakeoverPromptShownAt).toBeTruthy();
      const again = service.dismissSubagentTakeoverPrompt({ sessionId: child.id });
      expect(again.spawnKind).toBe("peer");
      expect(again.subagentTakeoverPromptShownAt).toBe(dismissed.subagentTakeoverPromptShownAt);
    });

    it("reports a stopped completion before deleting an unfinished child", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Deleted child",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      await service.deleteSession({ sessionId: child.id });

      await vi.waitFor(() => {
        const completion = events.find((event) =>
          event.sessionId === parent.id
          && event.event.type === "user_message"
          && event.event.metadata?.spawnCompletion?.childSessionId === child.id
        );
        expect(completion).toBeTruthy();
        expect(completion!.event.type === "user_message" && completion!.event.metadata?.spawnCompletion).toMatchObject({
          childSessionId: child.id,
          childTitle: "Deleted child",
          spawnKind: "subagent",
          status: "stopped",
          summary: "Stopped before finishing.",
        });
      });
    });

    it("notes a deleted parent once in the child and stops retrying", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let releaseTurn!: () => void;
      let markTurnStarted!: () => void;
      const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve; });
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-spawn-parent-gone", slash_commands: [] };
        markTurnStarted();
        await turnGate;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-spawn-parent-gone",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service, logger } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        orchestrationParentSessionId: parent.id,
        spawnKind: "subagent",
      });

      const turn = service.messageSession({
        sessionId: child.id,
        text: "Finish after the parent disappears.",
        metadata: {
          spawnDispatch: {
            parentSessionId: parent.id,
            dispatchedAt: "2026-08-01T00:02:00.000Z",
          },
        },
      });
      await turnStarted;
      await service.deleteSession({ sessionId: parent.id });
      releaseTurn();
      await turn;

      await vi.waitFor(() => {
        expect(events.filter((event) =>
          event.sessionId === child.id
          && event.event.type === "system_notice"
          && event.event.status === "spawn_parent_gone"
        )).toHaveLength(1);
      }, { timeout: 2_500 });
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.status === "spawn_completion_delivery_failed"
      )).toBe(false);
      expect((await service.getSessionSummary(child.id))?.spawnKind).toBe("peer");
      expect(logger.warn.mock.calls.filter(
        ([message]) => message === "agent_chat.spawn_completion_delivery_failed",
      )).toHaveLength(0);
      expect(logger.info.mock.calls.some(
        ([message]) => message === "agent_chat.spawn_completion_parent_gone",
      )).toBe(true);

      const parentGoneCount = () => events.filter((event) =>
        event.sessionId === child.id
        && event.event.type === "system_notice"
        && event.event.status === "spawn_parent_gone"
      ).length;
      await service.sendMessage({ sessionId: child.id, text: "Another turn." });
      await vi.waitFor(() => {
      expect(events.filter((event) =>
        event.sessionId === child.id && event.event.type === "done"
      ).length).toBeGreaterThanOrEqual(2);
      });
      expect(parentGoneCount()).toBe(1);
      expect(logger.info.mock.calls.filter(
        ([message]) => message === "agent_chat.spawn_completion_parent_gone",
      )).toHaveLength(1);
    });

    it("rejects the legacy silent spawn type for new child chats", async () => {
      const { service } = createService();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await expect(service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        orchestrationParentSessionId: parent.id,
        spawnKind: "none" as never,
      })).rejects.toThrow(/requires spawnKind 'subagent' or 'peer'/);
    });

    it("rejects a parented child chat with no explicit spawn type", async () => {
      const { service } = createService();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await expect(service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        orchestrationParentSessionId: parent.id,
      })).rejects.toThrow(/requires spawnKind 'subagent' or 'peer'/);
    });
  });

  // --------------------------------------------------------------------------
  // Claude subagent name capture (Task tool input -> task_started envelope)
  // --------------------------------------------------------------------------

  describe("claude subagent name capture", () => {
    it("attaches agentType from the Task tool input to subagent_* envelopes", async () => {
      const events: AgentChatEventEnvelope[] = [];

      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-name-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Assistant emits a Task tool_use block with subagent_type = "code-reviewer"
        yield {
          type: "assistant",
          message: {
            id: "msg-1",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_1",
                name: "Task",
                input: {
                  subagent_type: "code-reviewer",
                  description: "Review the auth module",
                  prompt: "Please review auth.ts for security gaps.",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        // SDK emits the canonical task lifecycle system messages referencing
        // the same tool_use id via parent_tool_use_id.
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          parent_tool_use_id: "toolu_task_1",
          description: "Review the auth module",
        };
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          parent_tool_use_id: "toolu_task_1",
          summary: "Reading file…",
          last_tool_name: "Read",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          parent_tool_use_id: "toolu_task_1",
          status: "completed",
          summary: "Found no issues",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-name-1",
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

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Spawn a code-reviewer subagent.",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result" && (e.event as any).taskId === "task-1",
      );

      const startEnvelope = events.find(
        (e) => e.event.type === "subagent_started" && (e.event as any).taskId === "task-1",
      );
      const progressEnvelope = events.find(
        (e) => e.event.type === "subagent_progress" && (e.event as any).taskId === "task-1",
      );
      const resultEnvelope = events.find(
        (e) => e.event.type === "subagent_result" && (e.event as any).taskId === "task-1",
      );

      expect((startEnvelope?.event as any)?.agentType).toBe("code-reviewer");
      expect((progressEnvelope?.event as any)?.agentType).toBe("code-reviewer");
      expect((resultEnvelope?.event as any)?.agentType).toBe("code-reviewer");
      expect((startEnvelope?.event as any)?.parentToolUseId).toBe("toolu_task_1");
      expect((startEnvelope?.event as any)?.model).toBeUndefined();

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("keeps the Agent tool name as `label` and subagent_type as `agentType`", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-label-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: {
            id: "msg-label-1",
            content: [
              {
                type: "tool_use",
                id: "toolu_label_1",
                name: "Agent",
                input: {
                  subagent_type: "general-purpose",
                  name: "competitor-mobile",
                  description: "Audit the mobile competitor",
                  prompt: "Audit it.",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-label-1",
          parent_tool_use_id: "toolu_label_1",
          description: "Audit the mobile competitor",
        };
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "task-label-1",
          parent_tool_use_id: "toolu_label_1",
          summary: "Reading…",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-label-1",
          parent_tool_use_id: "toolu_label_1",
          status: "completed",
          summary: "Audit complete",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-label-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Spawn a named subagent.",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result" && (e.event as any).taskId === "task-label-1",
      );

      const pick = (type: string) => events.find(
        (e) => e.event.type === type && (e.event as any).taskId === "task-label-1",
      )?.event as any;

      for (const type of ["subagent_started", "subagent_progress", "subagent_result"]) {
        const event = pick(type);
        expect(event, type).toBeDefined();
        // `subagent_type` is the agent TYPE; the Agent tool's `name` is the
        // human-chosen display label and must not overwrite it.
        expect(event.agentType, type).toBe("general-purpose");
        expect(event.label, type).toBe("competitor-mobile");
      }

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it.each([
      ["tool input before task_started", false],
      ["task_started before tool input", true],
    ] as const)("attaches the Task tool model override to subagent_started, not the parent session model (%s)", async (_order, lifecycleBeforeToolInput) => {
      const events: AgentChatEventEnvelope[] = [];

      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-model-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        const taskStarted = {
          type: "system",
          subtype: "task_started",
          task_id: "task-model-1",
          parent_tool_use_id: "toolu_task_model_1",
          description: "Scan the repo",
        };
        if (lifecycleBeforeToolInput) yield taskStarted;
        yield {
          type: "assistant",
          message: {
            id: "msg-model-1",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_model_1",
                name: "Task",
                input: {
                  subagent_type: "Explore",
                  description: "Scan the repo",
                  prompt: "Find the auth module.",
                  model: "opus",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        if (!lifecycleBeforeToolInput) yield taskStarted;
        yield {
          type: "system",
          subtype: "task_updated",
          task_id: "task-model-1",
          patch: { status: "running" },
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-model-1",
          parent_tool_use_id: "toolu_task_model_1",
          status: "completed",
          summary: "Found auth.ts",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-model-1",
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

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Spawn an Explore subagent on opus.",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result" && (e.event as any).taskId === "task-model-1",
      );

      const startEnvelope = events.find(
        (e) => e.event.type === "subagent_started"
          && (e.event as any).taskId === "task-model-1"
          && (e.event as any).model === "opus",
      );
      const started = events.filter(
        (e) => e.event.type === "subagent_started" && (e.event as any).taskId === "task-model-1",
      );
      const resultEnvelope = events.find(
        (e) => e.event.type === "subagent_result" && (e.event as any).taskId === "task-model-1",
      );
      expect((startEnvelope?.event as any)?.agentType).toBe("Explore");
      expect((startEnvelope?.event as any)?.model).toBe("opus");
      expect((startEnvelope?.event as any)?.model).not.toBe("sonnet");
      expect(started.some((event) => (event.event as any).model === "opus")).toBe(true);
      expect(started.some((event) => (event.event as any).model === "sonnet")).toBe(false);
      expect((resultEnvelope?.event as any)?.model).toBe("opus");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("corrects a lifecycle-first subagent row with the Task `name` as its label", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-name-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-name-1",
          parent_tool_use_id: "toolu_task_name_1",
          description: "Scan the repo",
        };
        yield {
          type: "assistant",
          message: {
            id: "msg-name-1",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_name_1",
                name: "Task",
                input: {
                  name: "Explore",
                  description: "Scan the repo",
                  prompt: "Find the auth module.",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-name-1",
          parent_tool_use_id: "toolu_task_name_1",
          status: "completed",
          summary: "Found auth.ts",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-name-1",
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
      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Spawn a named Explore subagent.",
      });
      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result" && (e.event as any).taskId === "task-name-1",
      );

      // A Task input carrying only `name` names the spawn; it is NOT an agent
      // type. It arrives after the lifecycle row, so the correction pass has to
      // republish subagent_started with the label attached.
      expect(events.some((event) =>
        event.event.type === "subagent_started"
        && (event.event as any).taskId === "task-name-1"
        && (event.event as any).label === "Explore"
        && (event.event as any).agentType === undefined,
      )).toBe(true);
      const namedResult = events.find((event) =>
        event.event.type === "subagent_result" && (event.event as any).taskId === "task-name-1",
      )?.event as any;
      expect(namedResult?.label).toBe("Explore");
      expect(namedResult?.agentType).toBeUndefined();

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("falls back gracefully when Task tool has no subagent_type", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-name-2", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Task tool input lacks subagent_type (older models)
        yield {
          type: "assistant",
          message: {
            id: "msg-2",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_2",
                name: "Task",
                input: {
                  description: "Audit something",
                  prompt: "Audit the change log.",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-2",
          parent_tool_use_id: "toolu_task_2",
          description: "Audit something",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-2",
          parent_tool_use_id: "toolu_task_2",
          status: "completed",
          summary: "Done",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-name-2",
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

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Run a subagent without an explicit type",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_started" && (e.event as any).taskId === "task-2",
      );

      const startEnvelope = events.find(
        (e) => e.event.type === "subagent_started" && (e.event as any).taskId === "task-2",
      );
      expect(startEnvelope).toBeDefined();
      // No agentType is fine — the renderer falls back to description.
      expect((startEnvelope?.event as any)?.agentType).toBeUndefined();
      expect((startEnvelope?.event as any)?.description).toBe("Audit something");
      expect((startEnvelope?.event as any)?.model).toBeUndefined();

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("routes a background shell command to background_task scheduled_work rows, not subagent events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Bash run_in_background-style task: no Task tool; SDK directly emits
        // task_started with task_type: "background" and no subagent agentType.
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-bg-1",
          description: "Launch dev desktop with desktop RPC socket enabled",
          command: "npm run dev:desktop",
          task_type: "background",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-bg-1",
          status: "completed",
          summary: "Process exited",
          usage: { duration_ms: 4200 },
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-bg-1",
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

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Kick off a background task.",
      });

      // A running background_task scheduled_work row appears immediately on spawn.
      const runningRow = await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "scheduled_work_update"
          && (e.event as any).id === "background:task-bg-1"
          && (e.event as any).status === "running",
      );
      expect((runningRow.event as any).kind).toBe("background_task");
      expect((runningRow.event as any).title).toBe("Launch dev desktop with desktop RPC socket enabled");

      // Terminal background_task row (with duration) on notification.
      const doneRow = await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "scheduled_work_update"
          && (e.event as any).id === "background:task-bg-1"
          && ((e.event as any).status === "completed" || (e.event as any).status === "done"),
      );
      expect((doneRow.event as any).summary).toContain("4200ms");

      // Crucially: NO subagent_* events were emitted for the background shell.
      const subagentEvents = events.filter((e) =>
        (e.event.type === "subagent_started"
          || e.event.type === "subagent_progress"
          || e.event.type === "subagent_result")
        && (e.event as any).taskId === "task-bg-1",
      );
      expect(subagentEvents).toEqual([]);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("keeps a native background Agent in Subagents without a duplicate Background row", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-real-sub-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: {
            id: "msg-real-1",
            content: [
              {
                type: "tool_use",
                id: "toolu_real_1",
                name: "Task",
                input: { subagent_type: "Explore", description: "Explore the repo", prompt: "Look around.", run_in_background: true },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-real-1",
          parent_tool_use_id: "toolu_real_1",
          subagent_type: "Explore",
          task_type: "local_agent",
          description: "Explore the repo",
        };
        // The SDK does not guarantee ordering between the lifecycle edge and
        // the authoritative background-membership level. The live smoke sent
        // task_started first, so exercise the late correction path here.
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{
            task_id: "task-real-1",
            task_type: "local_agent",
            description: "Explore the repo",
          }],
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-real-1",
          parent_tool_use_id: "toolu_real_1",
          status: "completed",
          summary: "Explored",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-real-sub-1",
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

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Spawn an Explore subagent.",
      });

      const startEnvelope = await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_started"
          && (e.event as any).taskId === "task-real-1"
          && (e.event as any).background === true,
      );
      expect((startEnvelope.event as any).agentType).toBe("Explore");
      expect((startEnvelope.event as any).background).toBe(true);
      expect((startEnvelope.event as any).providerSessionId).toBe(readPersistedChatState(session.id).sdkSessionId);
      // A real subagent must NOT produce a background_task scheduled row.
      expect(events.some((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:task-real-1",
      )).toBe(false);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("suppresses task_* events entirely when the SDK marks them skip_transcript", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-skip-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Ambient task — session title generator. Must not surface anywhere.
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-ambient-1",
          description: "Generate session title",
          task_type: "other",
          skip_transcript: true,
        };
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "task-ambient-1",
          summary: "thinking…",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-ambient-1",
          status: "completed",
          summary: "Done",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-skip-1",
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

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Drive an ambient task.",
      });

      // Give the runtime a beat to flush events for the ambient task.
      await vi.waitFor(() => {
        expect(events.some((e) => e.event.type === "status")).toBe(true);
      });

      const subagentEvents = events.filter((e) =>
        e.event.type === "subagent_started"
        || e.event.type === "subagent_progress"
        || e.event.type === "subagent_result"
      );

      expect(subagentEvents).toEqual([]);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("treats ambient tasks like skip_transcript and never counts them as activity", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let ambientLive = false;
      let holdAmbientComplete!: () => void;
      const holdAmbientCompletePromise = new Promise<void>((resolve) => { holdAmbientComplete = resolve; });
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-ambient-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-ambient-true",
          description: "Generate session title",
          task_type: "other",
          ambient: true,
        };
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{
            task_id: "task-ambient-true",
            description: "Generate session title",
            ambient: true,
          }],
        };
        ambientLive = true;
        await holdAmbientCompletePromise;
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-ambient-true",
          status: "completed",
          summary: "Done",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-ambient-1",
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

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Drive an ambient task.",
      });

      await vi.waitFor(() => {
        expect(events.some((e) => e.event.type === "status")).toBe(true);
        expect(ambientLive).toBe(true);
      });

      expect(events.filter((e) =>
        e.event.type === "subagent_started"
        || e.event.type === "subagent_progress"
        || e.event.type === "subagent_result"
      )).toEqual([]);

      holdAmbientComplete();
      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(service.hasActiveWorkloads()).toBe(false);
      });
    });
  });

  // --------------------------------------------------------------------------
  // claude background_task terminal statuses + restart reconciliation
  // --------------------------------------------------------------------------

  describe("claude background task lifecycle", () => {
    async function bootClaudeHooks(sessionId: string) {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () { return; }),
        close: vi.fn(),
        sessionId,
      } as any);
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.SubagentStop?.[0]?.hooks[0];
      expect(stopHook).toBeDefined();
      const fireSnapshot = async (backgroundTasks: unknown[]) => {
        await stopHook!(
          {
            hook_event_name: "SubagentStop",
            agent_id: `agent-${randomSuffix()}`,
            agent_type: "reviewer",
            last_assistant_message: "",
            background_tasks: backgroundTasks,
          } as any,
          undefined as any,
          { signal: new AbortController().signal } as any,
        );
      };
      return { service, session, events, fireSnapshot };
    }

    function randomSuffix() {
      return Math.random().toString(36).slice(2, 8);
    }

    it("emits a terminal background_task row exactly once when a hook snapshot drops an id", async () => {
      const { events, fireSnapshot } = await bootClaudeHooks("sdk-bg-diff-1");

      // Snapshot A contains id X (running); snapshot B omits it.
      await fireSnapshot([{ id: "bg-X", type: "shell", status: "running", command: "sleep 5" }]);
      await fireSnapshot([]);

      const bgXEvents = events.filter(
        (e) => e.event.type === "scheduled_work_update" && (e.event as any).id === "background:bg-X",
      );
      const runningCount = bgXEvents.filter((e) => (e.event as any).status === "running").length;
      const terminalCount = bgXEvents.filter((e) =>
        (e.event as any).status === "completed" || (e.event as any).status === "stopped",
      ).length;
      expect(runningCount).toBe(1);
      expect(terminalCount).toBe(1);
    });

    it("does not duplicate hook-native subagents into Background", async () => {
      const { events, fireSnapshot } = await bootClaudeHooks("sdk-bg-agent-filter");

      await fireSnapshot([
        { id: "agent-1", type: "subagent", status: "running", description: "Review code", agent_type: "reviewer" },
        { id: "shell-1", type: "shell", status: "running", description: "Watch build", command: "npm run watch" },
      ]);

      expect(events.some((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:agent-1",
      )).toBe(false);
      expect(events.some((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:shell-1",
      )).toBe(true);
    });

    it("reaps a background shell when its owning native subagent exits", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let releaseTurn: (() => void) | null = null;
      const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-parent-stop", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg-child-shell",
          parent_agent_id: "agent-parent",
          description: "child-owned background shell",
          command: "tail -f log",
          task_type: "background",
        };
        await turnGate;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-bg-parent-stop",
        stopTask,
      } as any);

      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "start child shell" });

      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "scheduled_work_update"
        && (event.event as any).id === "background:bg-child-shell"
        && (event.event as any).status === "running");

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.SubagentStop?.[0]?.hooks[0];
      expect(stopHook).toBeDefined();
      await stopHook!(
        {
          hook_event_name: "SubagentStop",
          agent_id: "agent-parent",
          agent_type: "reviewer",
          last_assistant_message: "parent finished",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );

      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "scheduled_work_update"
        && (event.event as any).id === "background:bg-child-shell"
        && (event.event as any).status === "stopped");
      expect(stopTask).toHaveBeenCalledWith("bg-child-shell");
      expect(events.some((event) =>
        event.event.type === "subagent_result" && (event.event as any).taskId === "bg-child-shell")).toBe(false);

      releaseTurn!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("converges hook diff-close with a task_notification terminal (no duplicate distinct terminal events)", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-converge", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg-conv",
          description: "background convergence",
          command: "npm run watch",
          task_type: "background",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "bg-conv",
          status: "completed",
          summary: "watcher stopped",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-bg-converge", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "watch" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-conv"
        && ((e.event as any).status === "completed" || (e.event as any).status === "stopped"));

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();

      // The signature-dedupe means the same terminal (completed) is emitted once.
      const terminalStatuses = events
        .filter((e) => e.event.type === "scheduled_work_update" && (e.event as any).id === "background:bg-conv")
        .map((e) => (e.event as any).status)
        .filter((s) => s === "completed" || s === "stopped");
      // Exactly one distinct terminal status survives (last-write-wins converges).
      const distinctTerminal = new Set(terminalStatuses);
      expect(distinctTerminal.size).toBeLessThanOrEqual(1);
      expect(terminalStatuses.length).toBeGreaterThanOrEqual(1);
    });

    it("keeps background work across a turn boundary, then settles it when the idle query dies", async () => {
      // A run_in_background shell keeps running across turns: the SDK query
      // stays alive and delivers the real completion on a later turn. Turn end
      // must NOT falsely settle it as stopped.
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      let endQuery: (() => void) | null = null;
      const queryEndPromise = new Promise<void>((resolve) => { endQuery = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-sweep", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Background shell starts but never reports a notification this turn.
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg-orphan" }],
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg-orphan",
          description: "long lived background",
          command: "tail -f log",
          task_type: "background",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        await queryEndPromise;
        throw new Error("idle query transport closed");
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close, sessionId: "sdk-bg-sweep", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "start bg" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-orphan"
        && (e.event as any).status === "running");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
      // Wait for the turn to actually settle so any (erroneous) turn-end sweep
      // would have fired by now.
      await vi.waitFor(() => {
        expect(events.some((e) => e.event.type === "done" && (e.event as any).status === "completed")).toBe(true);
      }, { timeout: 3_000 });

      // The background row must NOT have been settled at the turn boundary.
      const terminalBgRows = events.filter((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-orphan"
        && ((e.event as any).status === "stopped" || (e.event as any).status === "completed"));
      expect(terminalBgRows).toEqual([]);
      // And no subagent_result leaked for the background shell.
      expect(events.some((e) =>
        e.event.type === "subagent_result" && (e.event as any).taskId === "bg-orphan")).toBe(false);
      endQuery!();
      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-orphan"
        && (e.event as any).status === "stopped");
      await vi.waitFor(() => expect(service.hasActiveWorkloads()).toBe(false));
      expect(close).toHaveBeenCalled();
    });

    it("preserves lifecycle markers on scheduled wakes and clears them on user sends", async () => {
      // Regression for the settle lifecycle: a scheduled wake is not user
      // activity (a declared settle must survive it and re-settle at rest),
      // while a genuine user send clears settled/attention/turn-failure.
      let streamCall = 0;
      let warmupComplete = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-markers", slash_commands: [] };
          warmupComplete = true;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-markers", setPermissionMode,
      } as any);
      const { service, sessionService } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });

      sessionService.clearTurnStartMarkers.mockClear();
      sessionService.clearSessionActivity.mockClear();
      await service.sendMessage({
        sessionId: session.id,
        text: "wake prompt",
        metadata: {
          scheduledWake: {
            scheduleId: "cron-1",
            kind: "cron",
            firedAt: new Date().toISOString(),
            reason: "tick",
          },
        } as never,
      });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      expect(sessionService.clearSessionActivity).not.toHaveBeenCalled();

      await service.sendMessage({ sessionId: session.id, text: "real user reply" });
      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith(session.id);
      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledTimes(1);
      expect(sessionService.clearSessionActivity).toHaveBeenCalledWith(session.id);
      expect(sessionService.clearSessionActivity).toHaveBeenCalledTimes(1);
    });

    it("writes a receipt for every Claude approval it settles, not just a cleared map", async () => {
      // Resolving the waiter unblocks the SDK; it does NOT tell the transcript.
      // Without a `pending_input_resolved` per item the summary's restart
      // fallback keeps naming a card nothing can answer, and the row stays
      // stuck on "Needs you" with no way out.
      const { service, session, events, opts } = await openClaudeApprovalHarness("sdk-session-settle-receipts");
      expect(opts?.canUseTool).toBeDefined();

      const firstWaiter = opts!.canUseTool!(
        "Bash",
        { command: "echo one" },
        { signal: new AbortController().signal, toolUseID: "tool-settle-1" },
      );
      const secondWaiter = opts!.canUseTool!(
        "Bash",
        { command: "echo two" },
        { signal: new AbortController().signal, toolUseID: "tool-settle-2" },
      );
      await vi.waitFor(() => {
        expect(events.filter((event) => event.event.type === "approval_request").length)
          .toBeGreaterThanOrEqual(2);
      });
      const raisedItemIds = events
        .filter((event) => event.event.type === "approval_request")
        .map((event) => (event.event as { itemId: string }).itemId);

      await service.interrupt({ sessionId: session.id });
      await Promise.all([firstWaiter, secondWaiter]);

      // One receipt per card, and both cards named.
      const resolvedItemIds = events
        .filter((event) => event.event.type === "pending_input_resolved")
        .map((event) => (event.event as { itemId: string }).itemId);
      for (const itemId of raisedItemIds) {
        expect(resolvedItemIds.filter((candidate) => candidate === itemId)).toHaveLength(1);
      }
    });

    it("a suppressed always-allow rule drops the session option and never persists one", async () => {
      // `suppressAlwaysAllowRule` says the rule this approval would write is
      // broader than the ask itself. The card must not offer "Allow for
      // Session", and a client that sends `accept_for_session` anyway — an
      // older build, a scripted answer — must be downgraded to a one-shot
      // allow, or the SDK's refusal is silently overridden by ADE.
      const { service, session, events, opts } = await openClaudeApprovalHarness("sdk-session-suppress-always-allow");
      expect(opts?.canUseTool).toBeDefined();

      const raisedCards = () => events.filter((event) => event.event.type === "approval_request");
      const suppressed = opts!.canUseTool!(
        "Bash",
        { command: "rm -rf ./build" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-suppress-1",
          suppressAlwaysAllowRule: true,
          suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
        },
      );
      const raised = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request",
      );
      const request = (raised.event.detail as { request: PendingInputRequest }).request;
      expect(request.questions[0]?.options?.map((option) => option.value)).toEqual(["allow", "deny"]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: raised.event.itemId,
        decision: "accept_for_session",
      });
      // No updatedPermissions, and no persisted override: the SDK's suggestions
      // are not forwarded for an ask whose rule it suppressed.
      await expect(suppressed).resolves.toEqual({ behavior: "allow" });

      const second = opts!.canUseTool!(
        "Bash",
        { command: "echo still asking" },
        { signal: new AbortController().signal, toolUseID: "tool-suppress-2" },
      );
      await waitForCondition(() => raisedCards().length >= 2, "a second approval card for the same tool");
      const secondCard = raisedCards()[1]!.event as Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      await service.respondToInput({
        sessionId: session.id,
        itemId: secondCard.itemId,
        decision: "decline",
      });
      await expect(second).resolves.toMatchObject({ behavior: "deny" });
    });

    it("does not let a session-wide override auto-answer a suppressed ask", async () => {
      // The test above pins "a suppressed ask never persists a rule". This one
      // pins the other direction: a rule persisted from an earlier ask —
      // possibly restored from a previous app run — must not answer a
      // suppressed ask either, or the SDK's refusal is defeated by state ADE
      // kept for a different call. The override stays usable for ordinary asks.
      const { service, session, events, opts } = await openClaudeApprovalHarness("sdk-session-suppress-vs-override");
      const raisedCards = () => events.filter((event) => event.event.type === "approval_request");

      const ordinary = opts!.canUseTool!(
        "Bash",
        { command: "ls" },
        { signal: new AbortController().signal, toolUseID: "tool-override-1" },
      );
      const ordinaryCard = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request",
      );
      await service.respondToInput({
        sessionId: session.id,
        itemId: ordinaryCard.event.itemId,
        decision: "accept_for_session",
      });
      await expect(ordinary).resolves.toMatchObject({ behavior: "allow" });

      const suppressed = opts!.canUseTool!(
        "Bash",
        { command: "rm -rf ./build" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-override-2",
          suppressAlwaysAllowRule: true,
        },
      );
      await waitForCondition(() => raisedCards().length >= 2, "a card for the suppressed ask despite the override");
      const suppressedCard = raisedCards()[1]!.event as Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      expect((suppressedCard.detail as { request: PendingInputRequest }).request.questions[0]?.options?.map((option) => option.value)).toEqual(["allow", "deny"]);
      await service.respondToInput({
        sessionId: session.id,
        itemId: suppressedCard.itemId,
        decision: "accept",
      });
      await expect(suppressed).resolves.toMatchObject({ behavior: "allow" });

      // The override itself survives: an ordinary ask for the same tool after
      // the suppressed one is still answered from it, without a card.
      await expect(
        opts!.canUseTool!("Bash", { command: "pwd" }, { signal: new AbortController().signal, toolUseID: "tool-override-3" }),
      ).resolves.toMatchObject({ behavior: "allow" });
      expect(raisedCards()).toHaveLength(2);
    });

    it("persists a session-wide override before the next provider event", async () => {
      // The resolution receipt is the only state write before the `canUseTool`
      // continuation runs, and it cannot see the override the continuation
      // adds. Without an explicit persist there, "Allow for Session" survives
      // a crash only if the provider happens to emit another event first — the
      // user's choice must not depend on that.
      const { service, session, events, opts } = await openClaudeApprovalHarness("sdk-session-override-persist");

      const persistedOverrides = (): string[] =>
        (readPersistedChatState(session.id).approvalOverrides as string[] | undefined) ?? [];

      const ask = opts!.canUseTool!(
        "Bash",
        { command: "ls" },
        { signal: new AbortController().signal, toolUseID: "tool-persist-override-1" },
      );
      const card = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request",
      );
      expect(persistedOverrides()).toEqual([]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: card.event.itemId,
        decision: "accept_for_session",
      });
      await expect(ask).resolves.toMatchObject({ behavior: "allow" });
      // The override stores the normalized tool name, which is what the gate
      // reads back on the next ask.
      await waitFor(() => persistedOverrides().includes("bash"));
      expect(persistedOverrides()).toContain("bash");
    });

    it("reads a question-card option answer as the approval decision", async () => {
      // iOS renders an approval's options as chips and answers with `accept`
      // plus the chosen value in `answers`. The host reads `decision`, so
      // without this a chip labeled "Deny" would allow the tool — the exact
      // opposite of what the user tapped.
      const { service, session, events, opts } = await openClaudeApprovalHarness("sdk-session-option-answer");
      const raisedCards = () => events.filter((event) => event.event.type === "approval_request");

      const denied = opts!.canUseTool!(
        "Bash",
        { command: "rm -rf ./build" },
        { signal: new AbortController().signal, toolUseID: "tool-option-answer-1" },
      );
      const deniedCard = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request",
      );
      await service.respondToInput({
        sessionId: session.id,
        itemId: deniedCard.event.itemId,
        decision: "accept",
        answers: { tool_decision: "deny" },
      });
      await expect(denied).resolves.toMatchObject({ behavior: "deny" });
      // The durable receipt records the effective decision, not the raw
      // `accept`, or the transcript disagrees with what the tool did.
      const deniedReceipt = events.find((event) =>
        event.event.type === "pending_input_resolved"
        && (event.event as { itemId?: string }).itemId === deniedCard.event.itemId)?.event as
        { resolution?: string } | undefined;
      expect(deniedReceipt?.resolution).toBe("declined");

      // A typed answer rides the same channel: iOS freeform-only submissions
      // send `answers: nil` with the text in `responseText`.
      const typedDeny = opts!.canUseTool!(
        "Bash",
        { command: "rm -rf ./build" },
        { signal: new AbortController().signal, toolUseID: "tool-option-answer-typed" },
      );
      await waitForCondition(() => raisedCards().length >= 2, "a card for the typed answer");
      const typedCard = raisedCards()[1]!.event as Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      await service.respondToInput({
        sessionId: session.id,
        itemId: typedCard.itemId,
        decision: "accept",
        responseText: "deny",
      });
      await expect(typedDeny).resolves.toMatchObject({ behavior: "deny" });
      expect(raisedCards()).toHaveLength(2);

      // The session-wide chip persists the same override the desktop button
      // would: the next ask for the tool is answered without a card.
      const sessionWide = opts!.canUseTool!(
        "Bash",
        { command: "echo still asking" },
        { signal: new AbortController().signal, toolUseID: "tool-option-answer-2" },
      );
      await waitForCondition(() => raisedCards().length >= 3, "a third card for the session-wide chip");
      const sessionWideCard = raisedCards()[2]!.event as Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      await service.respondToInput({
        sessionId: session.id,
        itemId: sessionWideCard.itemId,
        decision: "accept",
        answers: { tool_decision: "allow_session" },
      });
      await expect(sessionWide).resolves.toMatchObject({ behavior: "allow" });
      await expect(
        opts!.canUseTool!("Bash", { command: "pwd" }, { signal: new AbortController().signal, toolUseID: "tool-option-answer-3" }),
      ).resolves.toMatchObject({ behavior: "allow" });
      expect(raisedCards()).toHaveLength(3);
    });

    it("does not read an AskUserQuestion option named deny as an approval verdict", async () => {
      // The approval mapping is guarded by pending kind: runtime.approvals also
      // holds AskUserQuestion (kind "question"), whose option values are
      // model-authored labels. Without the guard, an option a model happened to
      // spell `deny` would deny the whole question and drop the user's answer.
      const { service, session, events, opts } = await openClaudeApprovalHarness("sdk-session-question-deny-option");

      const asked = opts!.canUseTool!(
        "AskUserQuestion",
        {
          questions: [{
            id: "q1",
            question: "Which option?",
            header: "Pick",
            multiSelect: false,
            options: [
              { label: "deny", description: "an option the model named" },
              { label: "keep", description: "the other" },
            ],
          }],
        },
        { signal: new AbortController().signal, toolUseID: "tool-question-deny-option" },
      );
      const askedCard = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request",
      );
      await service.respondToInput({
        sessionId: session.id,
        itemId: askedCard.event.itemId,
        decision: "accept",
        answers: { q1: "deny" },
      });

      const result = await asked;
      expect(result).toMatchObject({ behavior: "allow" });
      expect(result.updatedInput).toMatchObject({ answers: { "Which option?": "deny" } });
    });

    it("clears the attention markers once an input card settles", async () => {
      // The reported bug: "you answer a question but then it stays as needs
      // you". Settling the card clears `pending_input_item_id`, but the
      // attention columns are a needs-you trigger in their OWN right — so
      // answering has to clear them too, including on the already-settled
      // branch, which is the one a double-click or a post-restart card takes.
      const { service, sessionService } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      sessionService.clearTurnStartMarkers.mockClear();
      sessionService.clearSessionActivity.mockClear();

      await service.respondToInput({
        sessionId: session.id,
        itemId: "item-nobody-owns",
        decision: "accept",
      });

      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith(session.id);
      expect(sessionService.clearSessionActivity).toHaveBeenCalledWith(session.id);
      // And a receipt was written, so the card cannot be redrawn either.
      const history = await service.getChatEventHistory(session.id);
      expect(history.events.some((envelope) =>
        envelope.event.type === "pending_input_resolved"
        && (envelope.event as { itemId: string }).itemId === "item-nobody-owns")).toBe(true);
    });

    it("never lets a host-authored delivery clear a raised hand", async () => {
      // The reported bug, from the other end: a child reporting in, or a
      // continuation ADE composed itself, used to clear the parent's attention
      // columns — so a real "Needs you" went quiet without anyone answering it.
      // Only a person may clear them.
      let streamCall = 0;
      let warmupComplete = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-host-authored", slash_commands: [] };
          warmupComplete = true;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-host-authored", setPermissionMode,
      } as any);
      const { service, sessionService } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });

      for (const metadata of [
        { spawnCompletion: { childSessionId: "chat-child", childTitle: "Child", summary: "done" } },
        { hostContinuation: { reason: "plan_followup" } },
      ]) {
        sessionService.clearTurnStartMarkers.mockClear();
        sessionService.clearSessionActivity.mockClear();
        await service.sendMessage({
          sessionId: session.id,
          text: "host-authored delivery",
          metadata: metadata as never,
        });
        expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
        expect(sessionService.clearSessionActivity).not.toHaveBeenCalled();
      }

      // A board move is host-authored provenance but a HUMAN act, so it does
      // clear — except a move INTO Needs you, which exists to raise the hand
      // the clear would wipe in the same breath.
      sessionService.clearTurnStartMarkers.mockClear();
      sessionService.clearSessionActivity.mockClear();
      await service.sendMessage({
        sessionId: session.id,
        text: "You moved this chat from Done to Working.",
        metadata: {
          boardMove: { from: "done", to: "working", at: new Date().toISOString(), moveId: "move-1" },
        } as never,
      });
      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith(session.id);
      expect(sessionService.clearSessionActivity).toHaveBeenCalledWith(session.id);

      sessionService.clearTurnStartMarkers.mockClear();
      sessionService.clearSessionActivity.mockClear();
      await service.sendMessage({
        sessionId: session.id,
        text: "The user parked this for their input.",
        metadata: {
          boardMove: { from: "working", to: "needs_you", at: new Date().toISOString(), moveId: "move-2" },
        } as never,
      });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      expect(sessionService.clearSessionActivity).not.toHaveBeenCalled();
    });

    it.each([
      ["opencode", "", "opencode/anthropic/claude-sonnet-5"],
      ["cursor", "composer-2", "cursor/composer-2"],
      ["droid", "custom:claude-sonnet-5-thinking-32000", "droid/custom:claude-sonnet-5-thinking-32000"],
    ] as const)(
      "clears lifecycle markers when an idle %s user steer is dispatched",
      async (provider, model, modelId) => {
        let finishTurn = () => {};
        const turnGate = new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        if (provider === "opencode") {
          vi.mocked(streamText).mockReturnValue({
            fullStream: (async function* () {
              yield { type: "text-delta", textDelta: "working" };
              await turnGate;
              yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
            })(),
          } as any);
        } else if (provider === "cursor") {
          process.env.CURSOR_API_KEY = "cursor-test-key";
          mockState.cursorSendPromptGate = turnGate;
        } else {
          mockState.droidPromptGate = turnGate;
        }

        const { service, sessionService } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider,
          model,
          modelId,
        });
        sessionService.clearTurnStartMarkers.mockClear();
        sessionService.clearSessionActivity.mockClear();

        let turnSettled = false;
        const steerPromise = service.steerUserMessage({
          sessionId: session.id,
          text: "Continue from my answer.",
        }).finally(() => {
          turnSettled = true;
        });

        try {
          if (provider === "cursor") {
            await vi.waitFor(() => {
              expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(0);
            });
            mockState.cursorSdkPooled.bridge.onRunStarted({
              agentId: "cursor-sdk-agent-1",
              runId: "cursor-sdk-run-1",
              modelSdkId: "composer-2",
            }, { runtime: "local" });
          } else if (provider === "droid") {
            await vi.waitFor(() => {
              expect(mockState.droidPromptCalls.length).toBeGreaterThan(0);
            });
            mockState.droidPooled.bridge.onEvent({
              type: "assistant",
              message: { content: [] },
            });
          }
          await vi.waitFor(() => {
            expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith(session.id);
          });
          expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledTimes(1);
          expect(sessionService.clearSessionActivity).toHaveBeenCalledWith(session.id);
          expect(sessionService.clearSessionActivity).toHaveBeenCalledTimes(1);
          expect(turnSettled).toBe(false);
        } finally {
          finishTurn();
        }
        await expect(steerPromise).resolves.toMatchObject({ queued: false });
      },
    );

    it("preserves lifecycle markers when an idle Cursor user steer is rejected before dispatch", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      vi.mocked(acquireCursorSdkConnection).mockRejectedValueOnce(
        new Error("Cursor rejected the dispatch."),
      );
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      sessionService.clearTurnStartMarkers.mockClear();
      sessionService.clearSessionActivity.mockClear();

      await expect(service.steerUserMessage({
        sessionId: session.id,
        text: "Continue from my answer.",
      })).rejects.toThrow("Cursor rejected the dispatch.");
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      expect(sessionService.clearSessionActivity).not.toHaveBeenCalled();
    });

    it("preserves lifecycle markers when an idle OpenCode prompt is rejected before dispatch", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      vi.mocked(streamText).mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start the reusable OpenCode runtime.",
      });
      const handle = await vi.mocked(startOpenCodeSession).mock.results.at(-1)!.value as {
        client: {
          session: {
            promptAsync: ReturnType<typeof vi.fn>;
          };
        };
      };
      handle.client.session.promptAsync.mockRejectedValueOnce(
        new Error("OpenCode rejected the prompt."),
      );
      sessionService.clearTurnStartMarkers.mockClear();

      await expect(service.steerUserMessage({
        sessionId: session.id,
        text: "Continue from my answer.",
      })).resolves.toMatchObject({ queued: false });
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
    });

    it("preserves lifecycle markers when a Cursor user steer is rejected by a full queue", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const finishTurn = parkCursorSend();
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Keep this turn active.",
      }, { awaitDispatch: true });
      for (let index = 0; index < 10; index += 1) {
        await expect(service.steer({
          sessionId: session.id,
          text: `Queued agent message ${index + 1}.`,
        })).resolves.toMatchObject({ queued: true });
      }
      sessionService.clearTurnStartMarkers.mockClear();

      try {
        await expect(service.steerUserMessage({
          sessionId: session.id,
          text: "This message should be rejected.",
        })).resolves.toMatchObject({
          queued: false,
          reason: "queue_full",
        });
        expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
      } finally {
        await service.interrupt({ sessionId: session.id });
        finishTurn();
      }
    });

    it("settles a still-open background task as stopped on interrupt (genuine teardown)", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-int", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg-int",
          description: "long lived background",
          command: "tail -f log",
          task_type: "background",
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-bg-int", setPermissionMode, stopTask,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "start bg" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-int"
        && (e.event as any).status === "running");

      await service.interrupt({ sessionId: session.id, mode: "stop_and_clear_and_background" });

      // Interrupt is a genuine teardown — the query is gone, so settle stopped.
      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-int"
        && (e.event as any).status === "stopped");
      expect(stopTask).toHaveBeenCalledWith("bg-int");
      // Still never a subagent_result for a background shell.
      expect(events.some((e) =>
        e.event.type === "subagent_result" && (e.event as any).taskId === "bg-int")).toBe(false);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("default interrupt leaves background tasks running once per-task stop exists", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-spare", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg-spare",
          description: "long lived background",
          command: "tail -f log",
          task_type: "background",
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-bg-spare", setPermissionMode, stopTask,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "start bg" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-spare"
        && (e.event as any).status === "running");

      await service.interrupt({ sessionId: session.id });

      expect(stopTask).not.toHaveBeenCalled();
      expect(events.some((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-spare"
        && (e.event as any).status === "stopped")).toBe(false);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("stops one running subagent and leaves siblings running", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-stop-one", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield { type: "assistant", message: { id: "m-stop-one", content: [
          { type: "tool_use", id: "toolu_A", name: "Task", input: { subagent_type: "Explore", description: "review A", prompt: "a" } },
          { type: "tool_use", id: "toolu_B", name: "Task", input: { subagent_type: "Explore", description: "review B", prompt: "b" } },
        ], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield { type: "system", subtype: "task_started", task_id: "task-A", agent_id: "agent-A", parent_tool_use_id: "toolu_A", description: "review A" };
        yield { type: "system", subtype: "task_started", task_id: "task-B", agent_id: "agent-B", parent_tool_use_id: "toolu_B", description: "review B" };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-stop-one", setPermissionMode, stopTask,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "spawn A and B" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_started" && (e.event as any).taskId === "task-B");

      await expect(service.stopTask({ sessionId: session.id, taskId: "task-A" }))
        .resolves.toMatchObject({ stopped: true, taskId: "task-A" });
      expect(stopTask).toHaveBeenCalledTimes(1);
      expect(stopTask).toHaveBeenCalledWith("task-A");

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_result"
        && (e.event as any).taskId === "task-A"
        && (e.event as any).status === "stopped");
      expect(events.some((e) =>
        e.event.type === "subagent_result" && (e.event as any).taskId === "task-B")).toBe(false);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("stops synthetic workflow agents when their parent task is stopped", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-stop-workflow", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "workflow-stop",
          task_type: "local_workflow",
          workflow_name: "stop-review",
          description: "Run stop review",
        };
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "workflow-stop",
          task_type: "local_workflow",
          workflow_name: "stop-review",
          description: "Run stop review",
          workflow_progress: [
            { type: "workflow_agent", index: 0, state: "start", startedAt: 1, label: "stop:review" },
          ],
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-stop-workflow", setPermissionMode, stopTask,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "start a workflow" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_started" && (e.event as any).taskId === "workflow-stop::a0");

      await expect(service.stopTask({ sessionId: session.id, taskId: "workflow-stop" }))
        .resolves.toMatchObject({ stopped: true, taskId: "workflow-stop" });
      expect(stopTask).toHaveBeenCalledWith("workflow-stop");
      expect(events).toContainEqual(expect.objectContaining({
        event: expect.objectContaining({
          type: "subagent_result",
          taskId: "workflow-stop::a0",
          status: "stopped",
          workflowName: "stop-review",
        }),
      }));

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("does not stop a task that belongs to a different session", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall <= 2) {
          yield { type: "system", subtype: "init", session_id: `sdk-stop-cross-${streamCall}`, slash_commands: [] };
          if (streamCall === 2) warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield { type: "system", subtype: "task_started", task_id: "task-A", description: "review A" };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      let queryN = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockImplementation(() => {
        queryN += 1;
        return {
          send,
          stream,
          close: vi.fn(),
          sessionId: `sdk-stop-cross-${queryN}`,
          setPermissionMode,
          stopTask,
        } as any;
      });
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const other = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "spawn A" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_started" && (e.event as any).taskId === "task-A");

      await expect(service.stopTask({ sessionId: other.id, taskId: "task-A" }))
        .resolves.toMatchObject({ stopped: false, reason: "That task is not running." });
      expect(stopTask).not.toHaveBeenCalled();

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("splits the background level into working and monitoring counts on the session summary", async () => {
      // The classifier is a DENYLIST: only a type whose whole job is to watch
      // (`monitor`) reads as monitoring. A generic backgrounded shell, a real
      // subagent, and anything unrecognised all count as working — an allowlist
      // would silently drop a real subagent the first time the SDK renamed a
      // task type, which is the exact failure this state exists to prevent.
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bgsplit-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            { task_id: "watch-ci", task_type: "monitor", description: "Watch CI" },
            { task_id: "run-build", task_type: "local_bash", description: "npm run build" },
            { task_id: "build-it", task_type: "local_agent", description: "Implement the feature" },
            { task_id: "who-knows", task_type: "some_future_sdk_type", description: "Unrecognised" },
          ],
        };
        await turnDonePromise;
        // The jobs finish on their own; the level is the authoritative drain.
        yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-bgsplit-1", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "kick off background work" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:watch-ci"
        && (e.event as any).status === "running");

      const live = await service.getSessionSummary(session.id);
      // Total stays the single number the mobile roster and push publisher read.
      expect(live?.activeBackgroundTaskCount).toBe(4);
      // Unknown types — and a generic backgrounded build — land in `working`,
      // never in the quiet column.
      expect(live?.backgroundWork).toEqual({ workingCount: 3, monitoringCount: 1 });


      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();

      // Background work outlives the turn by design, so the turn ending does not
      // drain it — only the SDK's own empty level does. Once drained, the record
      // is omitted entirely rather than riding along as a zero on every read.
      const drained = await service.getSessionSummary(session.id);
      expect(drained?.activeBackgroundTaskCount).toBe(0);
      expect(drained?.backgroundWork).toBeUndefined();
    });

    /**
     * The background-task exemption is what keeps a query alive past the
     * 5-minute idle window "until the work actually ends". These three cases pin
     * the second half of that promise, which nothing used to enforce:
     * `liveBackgroundTaskIds` was cleared only by teardown, and the flag itself
     * blocked teardown, so one task whose completion edge never arrived pinned
     * the SDK process (and its MCP children) for the life of the app.
     */
    const runBackgroundExemptionCase = async (args: {
      /** Extra levels the SDK publishes after the turn, released by the test. */
      laterLevels: unknown[][];
    }) => {
      const close = vi.fn();
      let streamCall = 0;
      const gates: Array<{ promise: Promise<void>; release: () => void }> = args.laterLevels.map(() => {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => { release = resolve; });
        return { promise, release };
      });
      let holdRelease!: () => void;
      const held = new Promise<void>((resolve) => { holdRelease = resolve; });
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg-1", task_type: "local_bash", description: "npm run build" }],
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        for (const [index, tasks] of args.laterLevels.entries()) {
          await gates[index]!.promise;
          yield { type: "system", subtype: "background_tasks_changed", tasks };
        }
        // Keep the idle reader attached: ending it would run the query-ended
        // teardown, which clears the level set and hides the very state under
        // test.
        await held;
      })());
      const sdk = {
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close,
        sessionId: "sdk-bg-exemption",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdk as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdk as any);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const turn = service.runSessionTurn({ sessionId: session.id, text: "start background work", timeoutMs: 15_000 });
      // Buffered-text and transcript flushes are timer-driven, so the turn only
      // settles once the fake clock is allowed to run.
      await vi.advanceTimersByTimeAsync(1_000);
      await turn;
      const publishNextLevel = async (index: number) => {
        gates[index]!.release();
        await vi.advanceTimersByTimeAsync(0);
      };
      return { close, events, publishNextLevel, release: holdRelease };
    };

    it("applies the warm-runtime budget across every chat service in the process", async () => {
      // The brain builds one agentChatService per open project scope, and the
      // cap used to be applied inside each one — so "at most 5 warm agent
      // runtimes" was really 5 x however many projects were open. Memory is
      // owned by the process, not by a project.
      const close = vi.fn();
      let holdRelease!: () => void;
      const held = new Promise<void>((resolve) => { holdRelease = resolve; });
      // One SDK object per acquire, so each session's warmup/turn stream has its
      // own call counter. The idle reader is held open afterwards: a query that
      // ends closes itself, and this test is about what the BUDGET closes.
      const makeSdk = () => {
        let streamCall = 0;
        return {
          send: vi.fn().mockResolvedValue(undefined),
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            if (streamCall > 1) await held;
          })()),
          close,
          sessionId: "sdk-budget",
          setPermissionMode: vi.fn().mockResolvedValue(undefined),
        };
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockImplementation(makeSdk as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockImplementation(makeSdk as any);

      // Exactly what a host does: one budget, handed to every project scope.
      const runtimeBudget = createChatRuntimeBudget();
      const first = createService({ runtimeBudget });
      const secondRoot = fs.mkdtempSync(path.join(tmpHomeRoot, "second-project-"));
      const second = createService({ runtimeBudget, projectRoot: secondRoot });
      try {
        const warm = async (service: ReturnType<typeof createService>["service"], text: string) => {
          const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
          await service.runSessionTurn({ sessionId: session.id, text, timeoutMs: 15_000 });
        };

        // Fill the budget inside the first service. Nothing is evicted: the cap
        // is only consulted before a runtime is added, so the fifth still fits.
        for (let index = 0; index < 5; index += 1) {
          await warm(first.service, `warm ${index}`);
        }
        expect(close).not.toHaveBeenCalled();

        // A sixth runtime in a DIFFERENT project must still cost something.
        await warm(second.service, "warm across projects");
        expect(close).toHaveBeenCalled();
      } finally {
        holdRelease();
        await first.service.disposeAll();
        await second.service.disposeAll();
      }
    });

    it("keeps a background-only runtime warm past the idle window, then reclaims it once the session reads Stale", async () => {
      vi.useFakeTimers();
      const { close, events, release } = await runBackgroundExemptionCase({ laterLevels: [] });
      try {
        // Well past SESSION_INACTIVITY_TIMEOUT_MS: the exemption is doing its job.
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(close).not.toHaveBeenCalled();

        // But it is no longer unbounded. Past SESSION_STALE_AFTER_MS every ADE
        // surface already calls this session Stale rather than Working, so the
        // warm process is reclaimed too.
        await vi.advanceTimersByTimeAsync(SESSION_STALE_AFTER_MS);
        expect(close).toHaveBeenCalled();

        // And the user is told why. This is the one teardown that ends work the
        // session still claimed; stopped rows with no reason attached read as a
        // bug rather than a decision.
        const notice = events.find((envelope) =>
          envelope.event.type === "system_notice"
          && typeof (envelope.event as { message?: unknown }).message === "string"
          && (envelope.event as { message: string }).message.includes("released the agent"));
        expect(notice).toBeDefined();
      } finally {
        release();
      }
    });

    it("does not reclaim a background-only runtime that is still reporting real changes", async () => {
      vi.useFakeTimers();
      const { close, publishNextLevel, release } = await runBackgroundExemptionCase({
        laterLevels: [[
          { task_id: "bg-1", task_type: "local_bash", description: "npm run build" },
          { task_id: "bg-2", task_type: "local_agent", description: "Implement the feature" },
        ]],
      });
      try {
        await vi.advanceTimersByTimeAsync(SESSION_STALE_AFTER_MS - 10 * 60_000);
        expect(close).not.toHaveBeenCalled();

        // A real membership change is the session doing something, so the
        // silence clock restarts from here.
        await publishNextLevel(0);
        await vi.advanceTimersByTimeAsync(SESSION_STALE_AFTER_MS - 10 * 60_000);
        expect(close).not.toHaveBeenCalled();
      } finally {
        release();
      }
    });

    it("treats a re-sent identical background level as silence, not activity", async () => {
      vi.useFakeTimers();
      // `background_tasks_changed` is level-triggered, so an unchanged set is
      // the SDK repeating itself. Counting it as activity reset the idle clock
      // on every frame and made the runtime immortal by construction.
      const { close, publishNextLevel, release } = await runBackgroundExemptionCase({
        laterLevels: [[{ task_id: "bg-1", task_type: "local_bash", description: "npm run build" }]],
      });
      try {
        await vi.advanceTimersByTimeAsync(SESSION_STALE_AFTER_MS - 10 * 60_000);
        expect(close).not.toHaveBeenCalled();
        await publishNextLevel(0);
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(close).toHaveBeenCalled();
      } finally {
        release();
      }
    });

    it("uses the SDK background level to distinguish background and foreground local_bash tasks", async () => {
      // `local_bash` is the implementation kind for both foreground and
      // background Bash. Only the SDK's authoritative membership level makes
      // the latter a Background row.
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-lbash-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "foreground-bash",
          description: "Foreground build",
          command: "sleep 1; echo done",
          task_type: "local_bash",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "foreground-bash",
          status: "completed",
          summary: "Process exited",
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "promoted-background-bash",
          description: "Promote this Bash task",
          command: "sleep 5",
          task_type: "local_bash",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          task_id: "promoted-background-bash",
          patch: { status: "running", is_backgrounded: true },
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "promoted-background-bash",
          status: "completed",
          summary: "Process exited",
        };
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{
            task_id: "bgo5i8f6y",
            task_type: "local_bash",
            description: "Run codex gpt-5.6-sol backend implementation (background)",
          }],
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bgo5i8f6y",
          description: "Run codex gpt-5.6-sol backend implementation (background)",
          command: "codex exec -m gpt-5.6-sol",
          task_type: "local_bash",
        };
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-lbash-1", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "run codex in background" });

      const runningRow = await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bgo5i8f6y"
        && (e.event as any).status === "running");
      expect((runningRow.event as any).kind).toBe("background_task");
      expect((runningRow.event as any).title).toBe("Run codex gpt-5.6-sol backend implementation (background)");
      expect(events.some((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bgo5i8f6y"
        && (e.event as any).status === "completed",
      )).toBe(true);
      expect(events.some((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:foreground-bash",
      )).toBe(false);
      expect(events.filter((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:promoted-background-bash",
      ).map((e) => (e.event as any).status)).toEqual(["running", "completed"]);

      // No subagent_* events for a background shell (this is the background:false
      // spawn-flag pollution the classifier now prevents).
      const subagentEvents = events.filter((e) =>
        (e.event.type === "subagent_started"
          || e.event.type === "subagent_progress"
          || e.event.type === "subagent_result")
        && (e.event as any).taskId === "bgo5i8f6y");
      expect(subagentEvents).toEqual([]);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("suppresses subagent rows for a plain Claude Code task run (no agent metadata)", async () => {
      // A task run like "Re-run affected test files" carries no agentType /
      // agentId and a non-subagent task type — it must never pollute the roster.
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-nonagent-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bwguvejv9",
          description: "Re-run affected test files",
          task_type: "other",
        };
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "bwguvejv9",
          summary: "running vitest",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "bwguvejv9",
          status: "completed",
          summary: "3 files passed",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-nonagent-1", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "run tests" });

      await vi.waitFor(() => {
        expect(events.some((e) => e.event.type === "status")).toBe(true);
      });

      // No subagent_* events AND no background_task row for a plain task run.
      const subagentEvents = events.filter((e) =>
        (e.event.type === "subagent_started"
          || e.event.type === "subagent_progress"
          || e.event.type === "subagent_result")
        && (e.event as any).taskId === "bwguvejv9");
      expect(subagentEvents).toEqual([]);
      const bgRows = events.filter((e) =>
        e.event.type === "scheduled_work_update" && (e.event as any).id === "background:bwguvejv9");
      expect(bgRows).toEqual([]);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("preserves the spawn title on a terminal background row when the hook diff-close omits it", async () => {
      // The hook diff-close terminal row carries no title; the sticky per-task
      // title must supply the original spawn description instead of a generic
      // "Background work" fallback.
      const { events, fireSnapshot } = await bootClaudeHooks("sdk-bg-title-1");

      await fireSnapshot([{
        id: "bg-title",
        type: "shell",
        status: "running",
        description: "Run codex gpt-5.6-sol backend implementation",
      }]);
      await fireSnapshot([]);

      const terminal = events.find((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-title"
        && ((e.event as any).status === "completed" || (e.event as any).status === "stopped"));
      expect(terminal).toBeDefined();
      expect((terminal!.event as any).title).toBe("Run codex gpt-5.6-sol backend implementation");
    });

    it("keeps each concurrent subagent's real final text over a generic task notification", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let stopHooksFired: (() => void) | null = null;
      const stopHooksFiredPromise = new Promise<void>((resolve) => { stopHooksFired = resolve; });
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-crosswire", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Two concurrent Task-tool subagents, A (task-A / agent-A) and B.
        yield { type: "assistant", message: { id: "m-cw", content: [
          { type: "tool_use", id: "toolu_A", name: "Task", input: { subagent_type: "reviewer", description: "review A", prompt: "a" } },
          { type: "tool_use", id: "toolu_B", name: "Task", input: { subagent_type: "reviewer", description: "review B", prompt: "b" } },
        ], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield { type: "system", subtype: "task_started", task_id: "task-A", agent_id: "agent-A", parent_tool_use_id: "toolu_A", description: "review A" };
        yield { type: "system", subtype: "task_started", task_id: "task-B", agent_id: "agent-B", parent_tool_use_id: "toolu_B", description: "review B" };
        yield { type: "system", subtype: "task_updated", task_id: "task-A", patch: { status: "completed" } };
        // The SubagentStop hooks fire out-of-band (below). Wait for them, then
        // deliver the generic completion summary for A.
        await stopHooksFiredPromise;
        yield { type: "system", subtype: "task_notification", task_id: "task-A", agent_id: "agent-A", parent_tool_use_id: "toolu_A", status: "completed", summary: "Agent finished" };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-crosswire", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.SubagentStop?.[0]?.hooks[0];
      expect(stopHook).toBeDefined();

      const sendPromise = service.sendMessage({ sessionId: session.id, text: "spawn A and B" });
      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_started" && (e.event as any).taskId === "task-B");

      const sig = { signal: new AbortController().signal } as any;
      // Both finish with distinctive messages; A's generic notification must
      // keep A's hook result and never steal B's.
      await stopHook!({ hook_event_name: "SubagentStop", agent_id: "agent-B", agent_type: "reviewer", last_assistant_message: "B-SECRET-RESULT" } as any, undefined as any, sig);
      await stopHook!({ hook_event_name: "SubagentStop", agent_id: "agent-A", agent_type: "reviewer", last_assistant_message: "A-REAL-RESULT" } as any, undefined as any, sig);
      stopHooksFired!();

      const aResult = await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_result" && (e.event as any).taskId === "task-A");
      expect(JSON.stringify(aResult.event)).not.toContain("B-SECRET-RESULT");
      expect((aResult.event as any).summary).toBe("A-REAL-RESULT");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("reconciles orphaned background rows + open subagents after an ADE restart with one system_notice", async () => {
      // Process 1: run a completed turn so the SDK session id + a real transcript
      // are persisted to disk. (The turn's content is irrelevant; we inject the
      // orphaned tail via the transcript parser mock below.)
      let streamCall = 0;
      let warmupComplete = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-restart-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-restart-1", setPermissionMode,
      } as any);
      const { service } = createService({ runtimeSocketPath: "/tmp/ade.sock" });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      await service.runSessionTurn({ sessionId: session.id, text: "seed the transcript" });

      // The persisted metadata now carries an sdkSessionId — the reconciler is
      // gated on a recovered SDK session id (any non-empty value triggers it).
      const persisted = readPersistedChatState(session.id);
      expect(typeof persisted.sdkSessionId).toBe("string");
      expect(persisted.sdkSessionId.length).toBeGreaterThan(0);
      expect(persisted.runtimeOwner?.socketPath).toBe("/tmp/ade.sock");

      // Process 2 (fresh host): a NEW service instance re-binds the persisted
      // session. Inject an orphaned transcript tail: one still-"running"
      // background_task row and one still-open real subagent from the previous
      // process. deriveBackgroundItems / subagentSnapshotsFromEvents read these.
      const orphanTail: AgentChatEventEnvelope[] = [
        { sessionId: session.id, timestamp: new Date().toISOString(), sequence: 1, event: {
          type: "user_message", text: "Work interrupted by restart", turnId: "turn-old",
          messageId: "idle-steer-parent-message", steerId: "idle-steer-before-restart", deliveryState: "delivered",
        } as any },
        { sessionId: session.id, timestamp: new Date().toISOString(), sequence: 2, event: {
          type: "scheduled_work_update", id: "background:bg-restart", kind: "background_task",
          status: "running", origin: "background_task", title: "npm run serve", summary: "shell",
          sourceTaskId: "bg-restart", turnId: "turn-old",
        } as any },
        { sessionId: session.id, timestamp: new Date().toISOString(), sequence: 3, event: {
          type: "subagent_started", taskId: "sub-restart", agentId: "sub-restart",
          agentType: "Explore", parentToolUseId: "toolu_sub_r", description: "look", turnId: "turn-old",
        } as any },
        // A backgrounded delegate is just as dead as a foreground one. The
        // restart path used to skip these and leave them "running" forever,
        // while the timer sweep closed the identical row.
        { sessionId: session.id, timestamp: new Date().toISOString(), sequence: 4, event: {
          type: "subagent_started", taskId: "sub-restart-bg", agentId: "sub-restart-bg",
          agentType: "Explore", parentToolUseId: "toolu_sub_bg", description: "watch",
          background: true, turnId: "turn-old",
        } as any },
      ];
      vi.mocked(parseAgentChatTranscript).mockReturnValue(orphanTail);

      const events2: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () { return; }),
        close: vi.fn(),
        sessionId: "sdk-restart-1",
      } as any);
      const { service: service2 } = createService({
        runtimeSocketPath: "/tmp/ade.sock",
        onEvent: (event: AgentChatEventEnvelope) => events2.push(event),
      });
      await service2.resumeSession({ sessionId: session.id });

      // Background_task row settled as stopped with the restart marker.
      const bgStopped = events2.find((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-restart"
        && (e.event as any).status === "stopped");
      expect(bgStopped).toBeTruthy();

      // Open subagent closed as stopped (interrupt-path parity).
      const subStopped = events2.find((e) =>
        e.event.type === "subagent_result"
        && (e.event as any).taskId === "sub-restart"
        && (e.event as any).status === "stopped");
      expect(subStopped).toBeTruthy();
      expect(subStopped?.event).toMatchObject({
        stopSource: "system",
        stopReason: "the ADE brain restarted",
      });
      expect(events2.find((e) =>
        e.event.type === "subagent_result"
        && (e.event as any).taskId === "sub-restart-bg")?.event).toMatchObject({
        status: "stopped",
        stopSource: "system",
      });

      // Exactly one compact reconciliation system_notice, counting background tasks.
      const notices = events2.filter((e) =>
        e.event.type === "system_notice"
        && typeof (e.event as any).message === "string"
        && (e.event as any).message.startsWith("Reconciled after restart:"));
      expect(notices).toHaveLength(1);
      expect((notices[0]!.event as any).message).toBe("Reconciled after restart: 1 background task stopped");

      expect(events2.filter((e) =>
        e.event.type === "status"
        && e.event.turnId === "turn-old"
        && e.event.turnStatus === "interrupted"
      )).toHaveLength(1);
      expect(events2.filter((e) =>
        e.event.type === "done"
        && e.event.turnId === "turn-old"
        && e.event.status === "interrupted"
      )).toHaveLength(1);
      const turnScopedEvents = events2.filter((event) => event.event.turnId);
      expect(turnScopedEvents.at(-1)?.event).toMatchObject({
        type: "done",
        turnId: "turn-old",
        status: "interrupted",
      });

      await service2.interrupt({ sessionId: session.id });
      expect(events2.filter((e) =>
        e.event.type === "status"
        && e.event.turnId === "turn-old"
        && e.event.turnStatus === "interrupted"
      )).toHaveLength(1);
      expect(events2.filter((e) =>
        e.event.type === "done"
        && e.event.turnId === "turn-old"
        && e.event.status === "interrupted"
      )).toHaveLength(1);
    });

    /**
     * The 17-24 hour rows. `reconcileClaudeSessionAfterRestart` only runs when
     * something re-binds the chat's runtime, so a chat nobody reopens keeps its
     * "running" subagent and background rows for as long as the transcript is
     * kept. The stale-run sweep closes them with no runtime involved.
     */
    describe("stale-run sweep (no runtime required)", () => {
      /**
       * The sweep reads the transcript from disk before it parses anything, so
       * the file has to exist even though `parseAgentChatTranscript` is mocked.
       */
      function writeTranscriptFile(sessionId: string): void {
        const dir = path.join(tmpRoot, "transcripts");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${sessionId}.chat.jsonl`),
          `${JSON.stringify({ sessionId, timestamp: "2026-09-18T02:00:00.000Z", event: { type: "system_notice", noticeKind: "info", message: "seed" } })}\n`,
          "utf8",
        );
      }

      function seedOrphanTranscript(sessionId: string, extra: AgentChatEventEnvelope[] = []): void {
        writeTranscriptFile(sessionId);
        vi.mocked(parseAgentChatTranscript).mockReturnValue([
          { sessionId, timestamp: "2026-09-18T02:00:00.000Z", sequence: 1, event: {
            type: "scheduled_work_update", id: "background:bg-stale", kind: "background_task",
            status: "running", origin: "background_task", title: "npm run serve", summary: "shell",
            sourceTaskId: "bg-stale", turnId: "turn-old",
          } as any },
          { sessionId, timestamp: "2026-09-18T02:00:01.000Z", sequence: 2, event: {
            type: "subagent_started", taskId: "sub-stale", agentId: "sub-stale",
            agentType: "Explore", parentToolUseId: "toolu_stale", description: "look", turnId: "turn-old",
          } as any },
          ...extra,
        ]);
      }

      it("terminalizes stale subagent and background rows for a chat nobody reopens", async () => {
        const sessionId = "claude-stale-sweep-1";
        const events: AgentChatEventEnvelope[] = [];
        const { service, sessionService } = createService({
          runtimeSocketPath: "/tmp/ade.sock",
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        sessionService.create({ sessionId, laneId: "lane-1", toolType: "claude-chat", transcriptPath: "" });
        seedOrphanTranscript(sessionId);

        service.reconcileStaleRuns();

        const bgStopped = events.filter((e) =>
          e.event.type === "scheduled_work_update"
          && (e.event as any).id === "background:bg-stale"
          && (e.event as any).status === "stopped");
        expect(bgStopped).toHaveLength(1);
        expect(bgStopped[0]!.event).toMatchObject({ stopSource: "system" });

        const subStopped = events.filter((e) =>
          e.event.type === "subagent_result"
          && (e.event as any).taskId === "sub-stale"
          && (e.event as any).status === "stopped");
        expect(subStopped).toHaveLength(1);
        expect(subStopped[0]!.event).toMatchObject({ stopSource: "system", stopReason: "the ADE brain restarted" });
      });

      it("emits each terminal row exactly once across repeated passes", async () => {
        const sessionId = "claude-stale-sweep-once";
        const events: AgentChatEventEnvelope[] = [];
        const { service, sessionService } = createService({
          runtimeSocketPath: "/tmp/ade.sock",
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        sessionService.create({ sessionId, laneId: "lane-1", toolType: "claude-chat", transcriptPath: "" });
        seedOrphanTranscript(sessionId);

        service.reconcileStaleRuns();
        service.reconcileStaleRuns();
        service.reconcileStaleRuns();

        expect(events.filter((e) => e.event.type === "subagent_result")).toHaveLength(1);
        expect(events.filter((e) =>
          e.event.type === "scheduled_work_update" && (e.event as any).status === "stopped")).toHaveLength(1);
      });

      it("leaves a chat whose runtime this brain still holds untouched", async () => {
        let warmupComplete = false;
        const stream = vi.fn(() => (async function* () {
          yield { type: "system", subtype: "init", session_id: "sdk-stale-live", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send: vi.fn().mockResolvedValue(undefined), stream, close: vi.fn(),
          sessionId: "sdk-stale-live", setPermissionMode: vi.fn().mockResolvedValue(undefined),
        } as any);
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          runtimeSocketPath: "/tmp/ade.sock",
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
        await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
        seedOrphanTranscript(session.id);
        const before = events.length;

        service.reconcileStaleRuns();

        expect(events.slice(before).filter((e) =>
          e.event.type === "subagent_result" || e.event.type === "scheduled_work_update")).toHaveLength(0);
      });

      it("finishes a spawned subagent chat that went idle with a report landed", async () => {
        const sessionId = "claude-stale-sweep-child";
        const childId = "child-chat-1";
        const events: AgentChatEventEnvelope[] = [];
        const { service, sessionService } = createService({
          runtimeSocketPath: "/tmp/ade.sock",
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        sessionService.create({ sessionId, laneId: "lane-1", toolType: "claude-chat", transcriptPath: "" });
        sessionService.create({ sessionId: childId, laneId: "lane-1", toolType: "claude-chat", transcriptPath: "" });
        // The child chat's own row is the second source of truth: still
        // "running" in the DB, but no live brain owns it, and it left a report.
        sessionService.setStatusNote(childId, "Ported the pane, tests green");
        writeTranscriptFile(sessionId);
        vi.mocked(parseAgentChatTranscript).mockReturnValue([
          { sessionId, timestamp: "2026-09-18T02:00:01.000Z", sequence: 1, event: {
            type: "subagent_started", taskId: `chat:${childId}`, agentType: "subagent",
            parentToolUseId: "toolu_child", description: "port the pane", turnId: "turn-old",
          } as any },
        ]);

        service.reconcileStaleRuns();

        const result = events.find((e) =>
          e.event.type === "subagent_result" && (e.event as any).taskId === `chat:${childId}`);
        expect(result?.event).toMatchObject({
          status: "completed",
          summary: "Ported the pane, tests green",
        });
        expect((result!.event as any).finalSummary).toContain("Finished (report landed)");
        expect((result!.event as any).stopSource).toBeUndefined();
      });
    });

    it("reconciles before an SDK id exists and emits only a missing terminal half", async () => {
      const sessionId = "claude-restart-before-sdk-init";
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      sessionService.create({
        sessionId,
        laneId: "lane-1",
        toolType: "claude-chat",
        title: "Restart before SDK init",
        startedAt: "2026-07-12T12:00:00.000Z",
      });
      writePersistedChatState(sessionId, {
        version: 2,
        sessionId,
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        updatedAt: "2026-07-12T12:00:00.000Z",
      });
      const chatTranscriptDir = path.join(tmpRoot, ".ade", "transcripts", "chat");
      fs.mkdirSync(chatTranscriptDir, { recursive: true });
      fs.writeFileSync(path.join(chatTranscriptDir, `${sessionId}.jsonl`), "{}\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([
        {
          sessionId,
          timestamp: "2026-07-12T12:00:00.000Z",
          sequence: 1,
          event: { type: "status", turnStatus: "started", turnId: "partial-terminal-turn" },
        },
        {
          sessionId,
          timestamp: "2026-07-12T12:00:01.000Z",
          sequence: 2,
          event: { type: "status", turnStatus: "interrupted", turnId: "partial-terminal-turn" },
        },
      ] as AgentChatEventEnvelope[]);

      await service.resumeSession({ sessionId });

      expect(events.filter((event) =>
        event.event.type === "status"
        && event.event.turnId === "partial-terminal-turn"
      )).toHaveLength(0);
      expect(events.filter((event) =>
        event.event.type === "done"
        && event.event.turnId === "partial-terminal-turn"
        && event.event.status === "interrupted"
      )).toHaveLength(1);
      expect(events.at(-1)?.event).toMatchObject({
        type: "done",
        turnId: "partial-terminal-turn",
        status: "interrupted",
      });
    });

    it("does not reconcile an ancient incomplete turn when the latest parent turn completed", async () => {
      const sessionId = "claude-restart-latest-complete";
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      sessionService.create({
        sessionId,
        laneId: "lane-1",
        toolType: "claude-chat",
        title: "Latest turn complete",
        startedAt: "2026-07-12T12:00:00.000Z",
      });
      writePersistedChatState(sessionId, {
        version: 2,
        sessionId,
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        updatedAt: "2026-07-12T12:00:00.000Z",
      });
      const chatTranscriptDir = path.join(tmpRoot, ".ade", "transcripts", "chat");
      fs.mkdirSync(chatTranscriptDir, { recursive: true });
      fs.writeFileSync(path.join(chatTranscriptDir, `${sessionId}.jsonl`), "{}\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([
        { sessionId, timestamp: "2026-07-12T12:00:00.000Z", sequence: 1, event: {
          type: "user_message", text: "Old turn", turnId: "old-open-turn",
        } },
        { sessionId, timestamp: "2026-07-12T12:00:00.100Z", sequence: 2, event: {
          type: "status", turnStatus: "started", turnId: "old-open-turn",
        } },
        { sessionId, timestamp: "2026-07-12T12:01:00.000Z", sequence: 3, event: {
          type: "user_message", text: "Latest turn", turnId: "latest-complete-turn",
        } },
        { sessionId, timestamp: "2026-07-12T12:01:00.100Z", sequence: 4, event: {
          type: "status", turnStatus: "started", turnId: "latest-complete-turn",
        } },
        { sessionId, timestamp: "2026-07-12T12:01:01.000Z", sequence: 5, event: {
          type: "status", turnStatus: "completed", turnId: "latest-complete-turn",
        } },
        { sessionId, timestamp: "2026-07-12T12:01:01.100Z", sequence: 6, event: {
          type: "done", status: "completed", turnId: "latest-complete-turn",
        } },
      ] as AgentChatEventEnvelope[]);

      await service.resumeSession({ sessionId });

      expect(events.filter((event) =>
        event.event.type === "status" && event.event.turnId === "old-open-turn"
      )).toHaveLength(0);
      expect(events.filter((event) =>
        event.event.type === "done" && event.event.turnId === "old-open-turn"
      )).toHaveLength(0);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message.startsWith("Reconciled after restart:")
      )).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // claude SDK session title adoption
  // --------------------------------------------------------------------------

  describe("claude SDK session title adoption", () => {
    async function runClaudeTurnWithSessionInfo(args: {
      sessionId: string;
      info: { summary?: string; customTitle?: string; firstPrompt?: string } | null;
      firstPrompt?: string;
      manuallyName?: boolean;
      turns?: number;
    }) {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: args.sessionId, slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield { type: "assistant", message: { id: `m-${streamCall}`, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: args.sessionId, setPermissionMode,
      } as any);
      vi.mocked(getSessionInfo).mockResolvedValue(args.info as any);

      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        // These tests prove native Claude titles win during the wait window.
        nativeTitleWaitMs: 250,
        projectConfigService: {
          get: vi.fn(() => ({
            effective: {
              ai: {
                permissions: {
                  cli: { mode: "edit" },
                  inProcess: { mode: "edit" },
                },
                chat: {},
                sessionIntelligence: { titles: { enabled: false } },
              },
            },
          })),
          getAll: vi.fn(() => ({})),
          set: vi.fn(),
        } as any,
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      if (args.manuallyName) {
        await service.updateSession({ sessionId: session.id, title: "Manual Title", manuallyNamed: true });
      }
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const turns = args.turns ?? 1;
      for (let i = 0; i < turns; i += 1) {
        await service.runSessionTurn({ sessionId: session.id, text: args.firstPrompt ?? "Fix update modal flow" });
      }
      return { service, sessionService, session, events };
    }

    it("adopts the SDK summary as the title when the chat still has the default name", async () => {
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-1",
        info: { summary: "Fix update modal flow", firstPrompt: "please help with something entirely different here" },
        firstPrompt: "please help with something entirely different here",
      });
      await waitForSessionTitle(sessionService, session.id, "Fix update modal flow");
    });

    it("does not adopt when the summary is just the first-prompt echo", async () => {
      const prompt = "Fix update modal flow";
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-2",
        info: { summary: prompt, firstPrompt: prompt },
        firstPrompt: prompt,
      });
      // Echoed SDK summaries are skipped; ADE names the chat after the wait.
      await waitForSessionTitle(sessionService, session.id, "Fix Update Modal Flow");
    });

    it("does not adopt when the session is manually named", async () => {
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-3",
        info: { summary: "Runtime Suggested Title", firstPrompt: "unrelated first prompt" },
        manuallyName: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sessionService.get(session.id)?.title).toBe("Manual Title");
    });

    it("only queries getSessionInfo once — stops after the title is adopted", async () => {
      vi.mocked(getSessionInfo).mockClear();
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-4",
        info: { summary: "Adopted Investigation", firstPrompt: "totally different opening prompt text" },
        firstPrompt: "totally different opening prompt text",
        turns: 2,
      });
      await waitForSessionTitle(sessionService, session.id, "Adopted Investigation");
      // Even across two turns, the adopt path stops after success.
      expect(vi.mocked(getSessionInfo).mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // getSlashCommands
  // --------------------------------------------------------------------------
});
