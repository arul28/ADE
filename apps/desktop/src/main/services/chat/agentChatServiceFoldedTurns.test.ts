import {
  AgentChatEventEnvelope,
  claudeSdkCreateSessionCompat,
  createClaudeStreamFixture,
  createService,
  fs,
  mockState,
  parseAgentChatTranscript,
  path,
  tmpHomeRoot,
  tmpRoot,
  waitForEvent,
} from "./agentChatService.testHarness";
import { describe, expect, it, vi } from "vitest";

describe("createAgentChatService", () => {
  describe("tracked CLI children (--mode cli)", () => {
    const CLI_ENDED_AT = "2026-09-23T10:00:00.000Z";

    function mockIdleClaudeParent(sdkSessionId: string): void {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield { type: "system", subtype: "init", session_id: sdkSessionId, slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: sdkSessionId,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);
    }

    function createCliHarness(options: {
      screen?: string[];
      runtimeState?: string;
      waitForResumeTargetBackfill?: (sessionId: string) => Promise<void>;
    } = {}) {
      const events: AgentChatEventEnvelope[] = [];
      let exitListener: ((event: any) => void) | null = null;
      const ptyService = {
        create: vi.fn(),
        sendToSession: vi.fn(),
        canAcceptScheduledTurn: vi.fn(() => false),
        getRuntimeState: vi.fn(() => "running"),
        waitForResumeTargetBackfill: vi.fn((sessionId: string) =>
          options.waitForResumeTargetBackfill?.(sessionId) ?? Promise.resolve()),
        enrichSessions: vi.fn((rows: any[]) => rows.map((row) => ({
          ...row,
          runtimeState: row.status === "running" ? options.runtimeState ?? "running" : "exited",
        }))),
        previewTerminal: vi.fn(async ({ terminalId }: { terminalId: string }) => ({
          terminalId,
          session: {} as any,
          source: "snapshot" as const,
          snapshot: {
            visibleRows: (options.screen ?? ["Running 12 tests", "All 12 tests passed."])
              .map((text) => ({ text, cells: [], wrapped: false })),
          } as any,
          transcript: null,
          capturedAt: CLI_ENDED_AT,
        })),
        onExit: vi.fn((listener: (event: any) => void) => {
          exitListener = listener;
          return () => { exitListener = null; };
        }),
      };
      const created = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        ptyService,
      });
      return {
        ...created,
        events,
        ptyService,
        hasExitListener: () => exitListener != null,
        fireExit: (sessionId: string, exitCode: number | null) =>
          exitListener?.({ sessionId, exitCode, ptyId: "pty-cli", laneId: "lane-1", projectRoot: tmpRoot }),
      };
    }

    function seedCliChild(sessionService: any, args: {
      id: string;
      parentId?: string | null;
      spawnKind?: "subagent" | "peer";
      title?: string;
    }) {
      sessionService.create({
        sessionId: args.id,
        laneId: "lane-1",
        toolType: "codex",
        title: args.title ?? "Fix flaky tests",
        transcriptPath: "",
      });
      const row = mockState.sessions.get(args.id);
      row.exitCode = null;
      row.resumeMetadata = {
        provider: "codex",
        targetKind: "thread",
        targetId: null,
        launch: { model: "gpt-5.6-sol" },
        ...(args.parentId ? { orchestrationParentSessionId: args.parentId, spawnKind: args.spawnKind ?? "subagent" } : {}),
      };
      return row;
    }

    function endCliChild(row: any, status: string, exitCode: number | null): void {
      row.status = status;
      row.exitCode = exitCode;
      row.endedAt = CLI_ENDED_AT;
    }

    const parentEventsFor = (events: AgentChatEventEnvelope[], parentId: string, childId: string) =>
      events.filter((e) => e.sessionId === parentId && (
        (e.event as any).taskId === `chat:${childId}`
        || (e.event as any).detail?.spawnedSession?.sessionId === childId
        || (e.event as any).detail?.spawnCompletion?.childSessionId === childId
        || (e.event as any).metadata?.spawnCompletion?.childSessionId === childId
      ));

    it("lands the spawn chip and a running card in the parent when a parented CLI starts", async () => {
      mockIdleClaudeParent("sdk-cli-parent-spawn");
      const { service, sessionService, events } = createCliHarness();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      seedCliChild(sessionService, { id: "cli-child-spawn", parentId: parent.id });

      expect(service.notifyParentOfCliChildSpawn("cli-child-spawn")).toBe(true);

      const rows = parentEventsFor(events, parent.id, "cli-child-spawn");
      expect(rows.map((e) => e.event.type)).toEqual(["system_notice", "subagent_started"]);
      expect(rows[0]!.event).toMatchObject({
        status: "subagent_spawned",
        detail: {
          spawnedSession: { sessionId: "cli-child-spawn", laneId: "lane-1", title: "Fix flaky tests" },
          spawnKind: "subagent",
          hasInlineCard: true,
        },
      });
      expect(rows[1]!.event).toMatchObject({
        taskId: "chat:cli-child-spawn",
        agentId: "cli-child-spawn",
        provider: "codex",
        agentType: "codex",
        description: "Fix flaky tests",
        taskType: "subagent",
        spawnKind: "subagent",
        model: "gpt-5.6-sol",
      });
    });

    it("reopens a completed CLI child card without adding another spawn chip", async () => {
      mockIdleClaudeParent("sdk-cli-parent-resume");
      const { service, sessionService, events, fireExit } = createCliHarness();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const row = seedCliChild(sessionService, { id: "cli-child-resume", parentId: parent.id });
      service.notifyParentOfCliChildSpawn(row.id);

      endCliChild(row, "completed", 0);
      fireExit(row.id, 0);
      await vi.waitFor(() => {
        expect(parentEventsFor(events, parent.id, row.id).some((entry) => entry.event.type === "subagent_result")).toBe(true);
      });

      expect(service.notifyParentOfCliChildSpawn(row.id, { resumed: true })).toBe(true);
      const rows = parentEventsFor(events, parent.id, row.id);
      expect(rows.filter((entry) => entry.event.type === "system_notice" && (entry.event as any).status === "subagent_spawned"))
        .toHaveLength(1);
      expect(rows.at(-1)?.event).toMatchObject({
        type: "subagent_started",
        provider: "codex",
        agentType: "codex",
        resumed: true,
      });
    });

    it("emits nothing for an unparented CLI, before or after it exits", async () => {
      mockIdleClaudeParent("sdk-cli-parent-none");
      const { service, sessionService, events, fireExit } = createCliHarness();
      await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const row = seedCliChild(sessionService, { id: "cli-no-parent", parentId: null });
      const before = events.length;

      expect(service.notifyParentOfCliChildSpawn("cli-no-parent")).toBe(false);
      endCliChild(row, "completed", 0);
      fireExit("cli-no-parent", 0);
      await Promise.resolve();

      expect(events.slice(before).filter((e) =>
        e.event.type === "subagent_started"
        || e.event.type === "subagent_result"
        || (e.event.type === "system_notice" && (e.event as any).status === "subagent_spawned")
      )).toEqual([]);
    });

    it("exit 0 closes the card as finished with the CLI's last lines and wakes a subagent parent", async () => {
      mockIdleClaudeParent("sdk-cli-parent-exit0");
      const { service, sessionService, events, fireExit } = createCliHarness();
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const row = seedCliChild(sessionService, { id: "cli-child-ok", parentId: parent.id });
      service.notifyParentOfCliChildSpawn("cli-child-ok");

      endCliChild(row, "completed", 0);
      fireExit("cli-child-ok", 0);

      await vi.waitFor(() => {
        const result = parentEventsFor(events, parent.id, "cli-child-ok")
          .find((e) => e.event.type === "subagent_result");
        expect(result?.event).toMatchObject({
          taskId: "chat:cli-child-ok",
          agentType: "codex",
          status: "completed",
          summary: "Running 12 tests\nAll 12 tests passed.",
        });
        const wake = parentEventsFor(events, parent.id, "cli-child-ok")
          .find((e) => e.event.type === "user_message");
        expect((wake?.event as any)?.metadata?.spawnCompletion).toMatchObject({
          childSessionId: "cli-child-ok",
          childTitle: "Fix flaky tests",
          spawnKind: "subagent",
          status: "completed",
          childTurnId: `cli-exit:${CLI_ENDED_AT}`,
        });
        expect((wake!.event as any).text).toContain("ade terminal read cli-child-ok");
      });
    });

    it("waits for the Codex resume target backfill before reading the child report", async () => {
      mockIdleClaudeParent("sdk-cli-parent-backfill");
      const codexHome = path.join(tmpHomeRoot, "codex-backfill");
      process.env.CODEX_HOME = codexHome;
      const threadId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
      const dayDir = path.join(codexHome, "sessions", "2026", "09", "23");
      fs.mkdirSync(dayDir, { recursive: true });
      fs.writeFileSync(
        path.join(dayDir, `rollout-2026-09-23T10-00-00-${threadId}.jsonl`),
        `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Codex report after backfill." } })}\n`,
      );

      let releaseBackfill!: () => void;
      const backfill = new Promise<void>((resolve) => { releaseBackfill = resolve; });
      const { service, sessionService, events, fireExit, ptyService } = createCliHarness({
        waitForResumeTargetBackfill: () => backfill,
      });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const row = seedCliChild(sessionService, { id: "cli-child-backfill", parentId: parent.id });
      service.notifyParentOfCliChildSpawn(row.id);
      endCliChild(row, "completed", 0);
      fireExit(row.id, 0);

      await vi.waitFor(() => expect(ptyService.waitForResumeTargetBackfill).toHaveBeenCalledWith(row.id));
      expect(parentEventsFor(events, parent.id, row.id).some((entry) => entry.event.type === "subagent_result")).toBe(false);
      row.resumeMetadata.targetId = threadId;
      releaseBackfill();

      await vi.waitFor(() => {
        expect(parentEventsFor(events, parent.id, row.id).find((entry) => entry.event.type === "subagent_result")?.event)
          .toMatchObject({ status: "completed", summary: "Codex report after backfill." });
      });
    });

    it("a non-zero exit closes the card as failed; a peer gets a quiet note, not a wake", async () => {
      mockIdleClaudeParent("sdk-cli-parent-fail");
      const { service, sessionService, events, fireExit } = createCliHarness({ screen: ["Error: ENOENT: no such file"] });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const row = seedCliChild(sessionService, { id: "cli-child-fail", parentId: parent.id, spawnKind: "peer" });
      service.notifyParentOfCliChildSpawn("cli-child-fail");

      endCliChild(row, "failed", 2);
      fireExit("cli-child-fail", 2);

      await vi.waitFor(() => {
        const rows = parentEventsFor(events, parent.id, "cli-child-fail");
        expect(rows.find((e) => e.event.type === "subagent_result")?.event).toMatchObject({
          status: "failed",
          summary: "CLI failed (exit code 2).\nError: ENOENT: no such file",
        });
        expect(rows.find((e) =>
          e.event.type === "system_notice" && (e.event as any).status === "spawn_completed"
        )?.event).toMatchObject({ detail: { spawnCompletion: { status: "failed", spawnKind: "peer" } } });
      });
      expect(parentEventsFor(events, parent.id, "cli-child-fail").some((e) => e.event.type === "user_message")).toBe(false);
    });

    describe("after a brain restart", () => {
      function seedParentTranscript(parentId: string, extra: AgentChatEventEnvelope[] = []): void {
        const dir = path.join(tmpRoot, "transcripts");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${parentId}.chat.jsonl`),
          `${JSON.stringify({ sessionId: parentId, timestamp: CLI_ENDED_AT, event: { type: "system_notice", noticeKind: "info", message: "seed" } })}\n`,
          "utf8",
        );
        vi.mocked(parseAgentChatTranscript).mockReturnValue([
          { sessionId: parentId, timestamp: "2026-09-23T09:00:00.000Z", sequence: 1, event: {
            type: "subagent_started", taskId: "chat:cli-child-restart", agentId: "cli-child-restart",
            agentType: "codex", parentToolUseId: null, description: "Fix flaky tests", taskType: "subagent",
            spawnKind: "subagent",
          } as any },
          ...extra,
        ]);
      }

      it("closes an ended CLI child's card through the CLI path, quietly, and never as a missing chat", async () => {
        const parentId = "cli-restart-parent";
        const { service, sessionService, events, fireExit } = createCliHarness({ screen: ["Wrote the fix, tests pending"] });
        sessionService.create({ sessionId: parentId, laneId: "lane-1", toolType: "claude-chat", transcriptPath: "" });
        const row = seedCliChild(sessionService, { id: "cli-child-restart", parentId });
        endCliChild(row, "disposed", null);
        seedParentTranscript(parentId);

        service.reconcileStaleRuns();
        // The live exit of the same run racing the reconcile must not double-deliver.
        fireExit("cli-child-restart", null);

        await vi.waitFor(() => {
          const results = events.filter((e) =>
            e.event.type === "subagent_result" && (e.event as any).taskId === "chat:cli-child-restart");
          expect(results).toHaveLength(1);
          expect(results[0]!.event).toMatchObject({
            status: "stopped",
            summary: "CLI session was closed before it exited on its own.\nWrote the fix, tests pending",
          });
          expect(events.some((e) =>
            e.event.type === "system_notice"
            && (e.event as any).status === "spawn_completed"
            && (e.event as any).detail?.spawnCompletion?.childTurnId === `cli-exit:${CLI_ENDED_AT}`
          )).toBe(true);
        });
        expect(events.some((e) =>
          e.event.type === "subagent_result" && /subagent chat is gone/.test(String((e.event as any).summary))
        )).toBe(false);
        // Recovering a child's end after the fact never starts a parent turn.
        expect(events.some((e) => e.event.type === "user_message")).toBe(false);
      });

      it("never re-closes a CLI child whose result already landed", async () => {
        const parentId = "cli-restart-parent-done";
        const { service, sessionService, events } = createCliHarness();
        sessionService.create({ sessionId: parentId, laneId: "lane-1", toolType: "claude-chat", transcriptPath: "" });
        const row = seedCliChild(sessionService, { id: "cli-child-restart", parentId });
        endCliChild(row, "disposed", null);
        seedParentTranscript(parentId, [
          { sessionId: parentId, timestamp: CLI_ENDED_AT, sequence: 2, event: {
            type: "subagent_result", taskId: "chat:cli-child-restart", agentId: "cli-child-restart",
            parentToolUseId: null, status: "completed", summary: "All 12 tests passed.", taskType: "subagent",
          } as any },
        ]);

        service.reconcileStaleRuns();
        await Promise.resolve();

        expect(events.filter((e) => e.event.type === "subagent_result")).toEqual([]);
      });
    });

    it("stops listening before the host tears its terminals down", async () => {
      const { service, hasExitListener } = createCliHarness();
      expect(hasExitListener()).toBe(true);
      await service.disposeAll();
      expect(hasExitListener()).toBe(false);
    });

    it("answers status, list, and read for a CLI child id", async () => {
      mockIdleClaudeParent("sdk-cli-parent-status");
      const { service, sessionService } = createCliHarness({ runtimeState: "waiting-input" });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const running = seedCliChild(sessionService, { id: "cli-child-live", parentId: parent.id });
      const ended = seedCliChild(sessionService, { id: "cli-child-done", parentId: parent.id, spawnKind: "peer" });
      endCliChild(ended, "completed", 0);
      seedCliChild(sessionService, { id: "cli-orphan", parentId: null });

      await expect(service.getTurnStatus(running.id)).resolves.toMatchObject({
        sessionId: running.id,
        phase: "blocked",
        provider: "codex",
        cliSession: { status: "running", parentSessionId: parent.id, spawnKind: "subagent" },
      });
      await expect(service.getTurnStatus(ended.id)).resolves.toMatchObject({
        phase: "idle",
        cliSession: {
          status: "completed",
          exitCode: 0,
          laneId: "lane-1",
          spawnKind: "peer",
          readHint: "ade terminal read cli-child-done",
        },
      });

      const listed = service.listCliChildSessions({ laneId: "lane-1" });
      expect(listed.map((entry) => entry.sessionId).sort()).toEqual(["cli-child-done", "cli-child-live"]);
      expect(listed.find((entry) => entry.sessionId === "cli-child-done")).toMatchObject({
        kind: "cli",
        provider: "codex",
        status: "completed",
        exitCode: 0,
        parentSessionId: parent.id,
      });
      expect(service.listCliChildSessions({ parentSessionId: "someone-else" })).toEqual([]);

      const read = await service.getChatTranscript({ sessionId: ended.id });
      expect(read.cliSession).toMatchObject({ status: "completed" });
      expect(read.entries).toHaveLength(1);
      expect(read.entries[0]!.text).toContain("All 12 tests passed.");
      expect(read.entries[0]!.text).toContain("ade terminal read cli-child-done");
      await expect(service.getChatTranscriptPage({ sessionId: ended.id })).rejects.toThrow(/ade terminal read cli-child-done/);
    });
  });

    it("keeps one message id for idle-reader deltas whose message_start it never saw", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      const messageId = "msg-idle-missed-start";
      const fragments = ["Idle ", "Claude ", "text ", "stays ", "whole."];
      const fullText = fragments.join("");
      let streamCall = 0;
      let startIdle!: () => void;
      const startIdlePromise = new Promise<void>((resolve) => { startIdle = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-missed-start",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-missed-start",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startIdlePromise;
        // No message_start: the foreground turn consumed it. Each delta frame
        // carries its own wire uuid and no message id.
        for (const [index, text] of fragments.entries()) {
          yield {
            type: "stream_event",
            uuid: `wire-idle-delta-${index + 1}`,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            },
          };
        }
        yield {
          type: "assistant",
          uuid: "wire-idle-assistant-snapshot",
          message: {
            id: messageId,
            content: [{ type: "text", text: fullText }],
            usage: { input_tokens: 1, output_tokens: 5 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-missed-start",
          usage: { input_tokens: 1, output_tokens: 5 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-missed-start",
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
        text: "Complete the foreground turn, then stream idle work.",
      });

      startIdle();
      const idleDone = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "done"
          && event.event.turnId.startsWith("claude-idle-")
          && event.event.status === "completed",
      );

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> =>
          event.type === "text" && event.turnId === idleDone.event.turnId
        );
      expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
      // One stable id (the first frame's), so the renderer draws one row and
      // the turn fold has no split fragments to hide.
      expect(new Set(textEvents.map((event) => event.messageId))).toEqual(new Set(["wire-idle-delta-1"]));
    });

    it("emits a data-only sources event for an agentMessage memoryCitation", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      await service.sendMessage({ sessionId: session.id, text: "What do you remember?" }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnStatus === "started",
      );

      // Shape from `codex app-server generate-ts` v2: MemoryCitation { entries, threadIds }.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "msg-memory",
            type: "agentMessage",
            text: "You prefer vitest.",
            phase: null,
            memoryCitation: {
              entries: [{ path: "/Users/me/.codex/memories/prefs.md", lineStart: 3, lineEnd: 5, note: "Testing prefs" }],
              threadIds: ["thr_old"],
            },
          },
        },
      });

      const sourcesEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "sources" }>;
        } => event.event.type === "sources" && event.event.itemId === "msg-memory",
      );
      expect(sourcesEvent.event.sources).toEqual([{
        kind: "file",
        path: "/Users/me/.codex/memories/prefs.md",
        cited: true,
        lineStart: 3,
        lineEnd: 5,
        snippet: "Testing prefs",
      }]);
    });

    it("stamps the Codex agentMessage phase onto that item's streamed text", async () => {
      const textEvents: Array<{ text: string; itemId?: string; phase?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          if (event.event.type !== "text") return;
          textEvents.push({
            text: event.event.text,
            itemId: event.event.itemId,
            ...("phase" in event.event ? { phase: event.event.phase } : {}),
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Fix the test.",
      });

      const agentMessage = (id: string, text: string, phase?: string | null) => ({
        type: "agentMessage",
        id,
        text,
        ...(phase !== undefined ? { phase } : {}),
      });
      // Labeled at item/started: every delta carries it.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item: agentMessage("msg-1", "", "commentary") },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", itemId: "msg-1", delta: "Looking " },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", itemId: "msg-1", delta: "at it." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { turnId: "turn-1", item: agentMessage("msg-1", "Looking at it.", "commentary") },
      });
      // No phase from the provider: stays unknown.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item: agentMessage("msg-2", "", null) },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", itemId: "msg-2", delta: "Unlabeled." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { turnId: "turn-1", item: agentMessage("msg-2", "Unlabeled.") },
      });
      // Phase first known at item/completed: labels text still in the buffer.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item: agentMessage("msg-3", "") },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", itemId: "msg-3", delta: "All green." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { turnId: "turn-1", item: agentMessage("msg-3", "All green.", "final_answer") },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });

      // Text is byte-identical to the deltas; only the label is added.
      expect(textEvents).toEqual([
        { text: "Looking at it.", itemId: "msg-1", phase: "commentary" },
        { text: "Unlabeled.", itemId: "msg-2" },
        { text: "All green.", itemId: "msg-3", phase: "final_answer" },
      ]);
    });

    it("forgets Codex agentMessage phases at the end of the turn", async () => {
      const textEvents: Array<{ text: string; turnId?: string; phase?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          if (event.event.type !== "text") return;
          textEvents.push({
            text: event.event.text,
            turnId: event.event.turnId,
            ...("phase" in event.event ? { phase: event.event.phase } : {}),
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({ sessionId: session.id, text: "First." }, { awaitDispatch: true });
      // Started with a phase but never completed before the turn ended.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: "", phase: "commentary" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", itemId: "msg-1", delta: "First turn." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await vi.waitFor(() => {
        expect(textEvents).toHaveLength(1);
      });

      await service.sendMessage({ sessionId: session.id, text: "Second." }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      });
      // Same item id in the next turn, with no item/started of its own.
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-2", itemId: "msg-1", delta: "Second turn." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", status: "completed" } },
      });

      await vi.waitFor(() => {
        expect(textEvents).toEqual([
          { text: "First turn.", turnId: "turn-1", phase: "commentary" },
          { text: "Second turn.", turnId: "turn-2" },
        ]);
      });
    });

    it("ignores the item/completed echo of a Codex subAgentActivity after the child settled", async () => {
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
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const activity = (method: "item/started" | "item/completed", id: string, kind: string) => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method,
          params: {
            turnId: "turn-1",
            item: {
              id,
              type: "subAgentActivity",
              agentThreadId: "agent-thread-echo",
              agentPath: "/root/desktop_scan",
              kind,
            },
          },
        });
      };
      const forAgent = (type: string) => events.filter((event) =>
        event.event.type === type && (event.event as { taskId?: string }).taskId === "agent-thread-echo");

      // Codex delivers the spawn item twice; only the first is a start.
      activity("item/started", "call-spawn-echo", "started");
      activity("item/completed", "call-spawn-echo", "started");
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_started" && event.event.taskId === "agent-thread-echo",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: "agent-thread-echo", turn: { id: "agent-turn-echo", status: "inProgress" } },
      });
      const childCompleted = {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "agent-thread-echo",
          turn: {
            id: "agent-turn-echo",
            status: "completed",
            items: [{ id: "agent-message-echo", type: "agentMessage", text: "Found one IPC guard gap." }],
          },
        },
      };
      mockState.emitCodexPayload(childCompleted);
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "subagent_result"
          && event.event.taskId === "agent-thread-echo"
          && event.event.status === "completed",
      );

      // The activity item's second delivery lands after the child settled.
      activity("item/started", "subagent-completed-agent-turn-echo", "completed");
      activity("item/completed", "subagent-completed-agent-turn-echo", "completed");
      // Had the echo re-marked the thread "running", a repeated child
      // turn/completed would settle it (and emit a result) a second time.
      mockState.emitCodexPayload(childCompleted);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done" && event.event.turnId === "turn-1",
      );

      expect(forAgent("subagent_started")).toHaveLength(1);
      expect(forAgent("subagent_result")).toHaveLength(1);
      const resultIndex = events.indexOf(forAgent("subagent_result")[0]!);
      expect(forAgent("subagent_progress").filter((event) => events.indexOf(event) > resultIndex)).toEqual([]);
      expect(await service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-echo",
          status: "completed",
          finalSummary: "Found one IPC guard gap.",
        }),
      ]);
      expect(service.hasActiveWorkloads()).toBe(false);
    });

  it("carries Claude WebSearch/WebFetch hits as tool_result sources and text citations as a sources event", async () => {
    // WebSearchOutput / WebFetchOutput from claude-agent-sdk sdk-tools.d.ts;
    // TextBlock.citations (web_search_result_location) from @anthropic-ai/sdk.
    const { events } = await createClaudeStreamFixture({
      sdkSessionId: "sdk-web-sources",
      messages: [
        {
          type: "assistant",
          message: {
            id: "assistant-web",
            content: [
              { type: "tool_use", id: "ws-1", name: "WebSearch", input: { query: "ade sources" } },
              { type: "tool_use", id: "wf-1", name: "WebFetch", input: { url: "https://ade-app.dev/docs", prompt: "read" } },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ws-1", content: "Web search results" }] },
          tool_use_result: {
            query: "ade sources",
            results: [{ tool_use_id: "srv-1", content: [{ title: "ADE docs", url: "https://ade-app.dev/docs" }] }, "summary"],
            durationSeconds: 0.4,
          },
        },
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "wf-1", content: "page" }] },
          tool_use_result: { url: "https://ade-app.dev/docs", code: 200, codeText: "OK", result: "page", bytes: 4, durationMs: 9 },
        },
        {
          type: "assistant",
          message: {
            id: "assistant-answer",
            content: [{
              type: "text",
              text: "ADE derives sources from the transcript.",
              citations: [{
                type: "web_search_result_location",
                url: "https://ade-app.dev/docs",
                title: "ADE docs",
                cited_text: "derives sources",
                encrypted_index: "idx",
              }],
            }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    });

    const flat = events.map((entry) => entry.event);
    expect(flat.find((event) => event.type === "tool_result" && event.itemId === "ws-1")).toMatchObject({
      sources: [{ kind: "web_search_result", url: "https://ade-app.dev/docs", title: "ADE docs", query: "ade sources" }],
    });
    expect(flat.find((event) => event.type === "tool_result" && event.itemId === "wf-1")).toMatchObject({
      sources: [{ kind: "fetched_url", url: "https://ade-app.dev/docs" }],
    });
    expect(flat.find((event) => event.type === "sources")).toMatchObject({
      type: "sources",
      itemId: "assistant-answer",
      sources: [{ kind: "citation", url: "https://ade-app.dev/docs", cited: true, title: "ADE docs", snippet: "derives sources" }],
    });
  });

});
