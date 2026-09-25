import {
  AgentChatEventEnvelope,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createService,
  fs,
  getSessionMessages,
  getSubagentMessages,
  gzipSync,
  installClaudeResponseFixture,
  installRealTranscriptParser,
  mockState,
  parseAgentChatTranscript,
  path,
  readPersistedChatState,
  runGit,
  startOpenCodeSession,
  streamText,
  tmpHomeRoot,
  tmpRoot,
  turnDiffMockState,
  waitFor,
  waitForEvent,
  writePersistedChatState,
  writeTestTranscriptEnvelopes,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

describe("createAgentChatService", () => {
  // --------------------------------------------------------------------------
  // emitAdeCard
  // --------------------------------------------------------------------------

  describe("emitAdeCard", () => {
    const proofCard = (over: Record<string, unknown> = {}) => ({
      cardId: "run-42",
      variant: "proof_artifact",
      state: "live" as const,
      title: "Pulling cloud artifacts",
      fallbackText: "1 cloud artifact pulled into the lane",
      ...over,
    });

    it("writes the card to the durable transcript with an assigned sequence", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      await service.emitAdeCard({ sessionId: session.id, card: proofCard() });

      // Live path.
      const emitted = events.filter((entry) => entry.event.type === "ade_card");
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.event).toMatchObject({ cardId: "run-42", variant: "proof_artifact" });
      expect(typeof emitted[0]!.sequence).toBe("number");

      // Durable path — the card is WRITTEN, which is what makes it replay on
      // reopen and reach mobile. (A live-only emit would pass the assertion
      // above and still be invisible everywhere else.)
      const durablePath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      await vi.waitFor(() => expect(fs.readFileSync(durablePath, "utf8")).toContain("\"ade_card\""));
      service.forceDisposeAll();
    });

    it("skips a byte-identical re-emit but writes a changed one", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      await service.emitAdeCard({ sessionId: session.id, card: proofCard() });
      await service.emitAdeCard({ sessionId: session.id, card: proofCard() });
      expect(events.filter((entry) => entry.event.type === "ade_card")).toHaveLength(1);

      await service.emitAdeCard({
        sessionId: session.id,
        card: proofCard({ state: "terminal", title: "Cloud artifacts pulled" }),
      });
      const emitted = events.filter((entry) => entry.event.type === "ade_card");
      expect(emitted).toHaveLength(2);
      // Same identity, and createdAt carried forward from the first emit so the
      // client can compute elapsed across the update.
      expect(emitted[1]!.event).toMatchObject({ cardId: "run-42", state: "terminal" });
      expect((emitted[1]!.event as { createdAt?: string }).createdAt)
        .toBe((emitted[0]!.event as { createdAt?: string }).createdAt);
      service.forceDisposeAll();
    });

    it("retries an identical card after its durable transcript append fails", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const durablePath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      const originalAppend = fs.promises.appendFile.bind(fs.promises);
      const appendFault = vi.spyOn(fs.promises, "appendFile").mockImplementation(async (candidate, data, options) => {
        if (path.resolve(String(candidate)) === path.resolve(durablePath)) {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return await originalAppend(candidate, data, options);
      });

      await expect(service.emitAdeCard({ sessionId: session.id, card: proofCard() }))
        .rejects.toThrow(/no space left/i);
      appendFault.mockRestore();

      await expect(service.emitAdeCard({ sessionId: session.id, card: proofCard() }))
        .resolves.toBeUndefined();
      expect(events.filter((entry) => entry.event.type === "ade_card")).toHaveLength(2);
      expect(fs.readFileSync(durablePath, "utf8")).toContain("\"ade_card\"");
      service.forceDisposeAll();
    });

    it("fills an empty fallbackText rather than shipping a card that degrades to nothing", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      await service.emitAdeCard({ sessionId: session.id, card: proofCard({ fallbackText: "  " }) });

      const emitted = events.find((entry) => entry.event.type === "ade_card")!;
      expect((emitted.event as { fallbackText: string }).fallbackText.trim().length).toBeGreaterThan(0);
      service.forceDisposeAll();
    });

    it("rejects a card with no session or no cardId", async () => {
      const { service } = createService();
      await expect(service.emitAdeCard({ sessionId: "  ", card: proofCard() })).rejects.toThrow(/chat session/i);
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      await expect(service.emitAdeCard({ sessionId: session.id, card: proofCard({ cardId: " " }) }))
        .rejects.toThrow(/cardId/i);
      service.forceDisposeAll();
    });
  });

  // --------------------------------------------------------------------------
  // getChatTranscript
  // --------------------------------------------------------------------------

  describe("getChatTranscript", () => {
    it("returns empty entries for a freshly created session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const transcript = await service.getChatTranscript({ sessionId: session.id });
      expect(transcript.sessionId).toBe(session.id);
      expect(transcript.entries).toEqual([]);
      expect(transcript.truncated).toBe(false);
      expect(transcript.totalEntries).toBe(0);
    });

    it("throws for unknown session", async () => {
      const { service } = createService();
      await expect(
        service.getChatTranscript({ sessionId: "nonexistent-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("keeps displayText as metadata while preserving the full user prompt", async () => {
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
        text: "Full handoff prompt with all implementation details.",
        displayText: "Pearl UI audit handoff",
      });

      const envelope = await waitForEvent(events, (event): event is AgentChatEventEnvelope => event.event.type === "user_message");
      expect(envelope.event).toMatchObject({
        type: "user_message",
        text: "Full handoff prompt with all implementation details.",
        displayText: "Pearl UI audit handoff",
      });

      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);
      const transcript = await service.getChatTranscript({ sessionId: session.id });
      expect(transcript.entries[0]).toMatchObject({
        role: "user",
        text: "Full handoff prompt with all implementation details.",
        displayText: "Pearl UI audit handoff",
      });
    });

    it("counts displayText against the hard transcript character budget", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      vi.mocked(parseAgentChatTranscript).mockReturnValue([{
        sessionId: session.id,
        timestamp: "2026-08-01T00:00:00.000Z",
        sequence: 1,
        event: {
          type: "user_message",
          text: "Hidden full prompt",
          displayText: "d".repeat(1_000),
        },
      }]);

      const transcript = await service.getChatTranscript({
        sessionId: session.id,
        maxChars: 200,
      });

      expect(transcript.entries).toHaveLength(1);
      expect((transcript.entries[0]?.displayText?.length ?? 0) + transcript.entries[0]!.text.length).toBeLessThanOrEqual(200);
      expect(transcript.entries[0]?.displayText).toBe(`${"d".repeat(197)}...`);
      expect(transcript.entries[0]?.text).toBe("");
      expect(transcript.truncated).toBe(true);
    });

    it("reads active transcripts from the uncapped dedicated transcript after the legacy cap", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const legacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-before-cap" },
        sequence: 1,
      };
      const dedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "dedicated-post-cap" },
        sequence: 2,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(legacyEnvelope)}\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n`,
        "utf8",
      );
      fs.writeFileSync(dedicatedTranscriptFile, `${JSON.stringify(dedicatedEnvelope)}\n`, "utf8");
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:01:00.000Z"), new Date("2026-04-23T10:01:00.000Z"));
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:02:00.000Z"), new Date("2026-04-23T10:02:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-post-cap")
          ? [dedicatedEnvelope]
          : raw.includes("legacy-before-cap")
            ? [legacyEnvelope]
            : [],
      );

      const transcript = await service.getChatTranscript({ sessionId: session.id });

      expect(transcript.entries.map((entry) => entry.text)).toEqual(["dedicated-post-cap"]);
    });

    it("coalesces streamed assistant fragments before applying transcript limits", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const events: AgentChatEventEnvelope[] = [{
        sessionId: session.id,
        timestamp: "2026-05-18T23:40:00.000Z",
        sequence: 1,
        event: {
          type: "user_message",
          text: "Count to 6000.",
          turnId: "turn-long",
        },
      }];
      for (let index = 1; index <= 130; index += 1) {
        events.push({
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:01.000Z",
          sequence: (index * 2),
          event: {
            type: "text",
            text: `${index}\n`,
            messageId: "assistant-message-long",
            turnId: "turn-long",
          },
        });
        events.push({
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:01.000Z",
          sequence: (index * 2) + 1,
          event: {
            type: "text",
            text: `other-${index}\n`,
            turnId: "turn-other",
          },
        });
      }
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(events);

      const transcript = await service.getChatTranscript({
        sessionId: session.id,
        limit: 100,
        maxChars: 40_000,
      });

      expect(transcript.totalEntries).toBe(3);
      expect(transcript.truncated).toBe(false);
      expect(transcript.entries).toHaveLength(3);
      expect(transcript.entries[1]).toMatchObject({
        role: "assistant",
        text: expect.stringMatching(/^1\n2\n3/),
        turnId: "turn-long",
      });
      expect(transcript.entries[1]!.text).toContain("\n130");
      expect(transcript.entries[2]).toMatchObject({
        role: "assistant",
        text: expect.stringMatching(/^other-1\nother-2/),
        turnId: "turn-other",
      });
    });

    it("keeps paragraph boundaries when same-turn assistant text resumes after another event", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const events: AgentChatEventEnvelope[] = [
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:00.000Z",
          sequence: 1,
          event: {
            type: "text",
            text: "The fake bottom row is now a 1-point sentinel.",
            turnId: "turn-formatting",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:01.000Z",
          sequence: 2,
          event: {
            type: "tool_call",
            tool: "shell",
            args: {},
            itemId: "tool-1",
            turnId: "turn-formatting",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:02.000Z",
          sequence: 3,
          event: {
            type: "text",
            text: "Next I am threading status through the end marker.",
            turnId: "turn-formatting",
          },
        },
      ];
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(events);

      const transcript = await service.getChatTranscript({ sessionId: session.id });

      expect(transcript.entries).toHaveLength(1);
      expect(transcript.entries[0]).toMatchObject({
        role: "assistant",
        text: "The fake bottom row is now a 1-point sentinel.\n\nNext I am threading status through the end marker.",
        turnId: "turn-formatting",
      });
    });

    it("includes assistant message ids in transcript entries", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const events: AgentChatEventEnvelope[] = [
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:00.000Z",
          sequence: 1,
          event: {
            type: "text",
            text: "Stable identified message.",
            messageId: "message-1",
            itemId: "item-1",
            turnId: "turn-ids",
          },
        },
      ];
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(events);

      const transcript = await service.getChatTranscript({ sessionId: session.id });

      expect(transcript.entries[0]).toMatchObject({
        role: "assistant",
        text: "Stable identified message.",
        messageId: "message-1",
        itemId: "item-1",
        turnId: "turn-ids",
      });
    });

    it("pages with append-stable byte cursors without parsing the full transcript", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const exactLine = (index: number): string => {
        const text = `message-${index}-`;
        const envelope: AgentChatEventEnvelope = {
          sessionId: session.id,
          timestamp: new Date(Date.UTC(2026, 6, 24, 10, 0, index)).toISOString(),
          sequence: index,
          event: {
            type: "user_message",
            text,
            turnId: `turn-${index}`,
          },
        };
        let line = `${JSON.stringify(envelope)}\n`;
        const padding = 40_000 - Buffer.byteLength(line, "utf8");
        expect(padding).toBeGreaterThanOrEqual(0);
        envelope.event = {
          type: "user_message",
          text: `${text}${"x".repeat(padding)}`,
          turnId: `turn-${index}`,
        };
        line = `${JSON.stringify(envelope)}\n`;
        expect(Buffer.byteLength(line, "utf8")).toBe(40_000);
        return line;
      };
      const transcriptFile = path.join(
        tmpRoot,
        ".ade",
        "transcripts",
        "chat",
        `${session.id}.jsonl`,
      );
      const original = Array.from({ length: 10 }, (_, index) => exactLine(index));
      fs.writeFileSync(transcriptFile, original.join(""), "utf8");

      const newest = await service.getChatTranscriptPage({
        sessionId: session.id,
        limit: 2,
        maxChars: 100_000,
      });
      expect(newest.cursorKind).toBe("byte");
      expect(newest.entries.map((entry) => entry.text.slice(0, 10))).toEqual([
        "message-8-",
        "message-9-",
      ]);
      expect(newest.nextCursor).toBe(8 * 40_000);

      fs.appendFileSync(transcriptFile, exactLine(10), "utf8");
      const older = await service.getChatTranscriptPage({
        sessionId: session.id,
        beforeOffset: newest.nextCursor!,
        limit: 2,
        maxChars: 100_000,
      });
      expect(older.entries.map((entry) => entry.text.slice(0, 10))).toEqual([
        "message-6-",
        "message-7-",
      ]);
      expect(older.nextCursor).toBe(6 * 40_000);
      expect(older.entries.some((entry) => entry.text.startsWith("message-10-"))).toBe(false);
    });

    it("pages duplicate-looking transcript rows by occurrence without skipping one", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const duplicate: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-07-24T10:00:00.000Z",
        event: {
          type: "user_message",
          text: "same text",
          turnId: "same-turn",
        },
      };
      const line = `${JSON.stringify(duplicate)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const transcriptFile = path.join(
        tmpRoot,
        ".ade",
        "transcripts",
        "chat",
        `${session.id}.jsonl`,
      );
      fs.writeFileSync(transcriptFile, line.repeat(3), "utf8");

      const newest = await service.getChatTranscriptPage({
        sessionId: session.id,
        limit: 2,
      });
      expect(newest.entries).toHaveLength(2);
      expect(newest.nextCursor).toBe(lineBytes);

      const older = await service.getChatTranscriptPage({
        sessionId: session.id,
        beforeOffset: newest.nextCursor!,
        limit: 2,
      });
      expect(older.entries).toHaveLength(1);
      expect(older.nextCursor).toBeNull();
    });

    it("clips an oversize boundary entry to the hard character budget", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const fullText = "x".repeat(1_000);
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-07-24T10:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: fullText, turnId: "turn-oversize" },
      };
      const transcriptFile = path.join(
        tmpRoot,
        ".ade",
        "transcripts",
        "chat",
        `${session.id}.jsonl`,
      );
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");

      const page = await service.getChatTranscriptPage({
        sessionId: session.id,
        limit: 10,
        maxChars: 200,
      });

      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.text).toHaveLength(200);
      expect(page.entries[0]?.text).toBe(`${"x".repeat(197)}...`);
      expect(page.truncated).toBe(true);
      expect(page.nextCursor).toBeNull();
    });

    it("counts displayText against the paged transcript character budget", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-08-01T00:00:00.000Z",
        sequence: 1,
        event: {
          type: "user_message",
          text: "Hidden full prompt",
          displayText: "d".repeat(1_000),
        },
      };
      const transcriptFile = path.join(
        tmpRoot,
        ".ade",
        "transcripts",
        "chat",
        `${session.id}.jsonl`,
      );
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");

      const page = await service.getChatTranscriptPage({
        sessionId: session.id,
        maxChars: 200,
      });

      expect(page.entries).toHaveLength(1);
      expect((page.entries[0]?.displayText?.length ?? 0) + page.entries[0]!.text.length).toBeLessThanOrEqual(200);
      expect(page.entries[0]?.displayText).toBe(`${"d".repeat(197)}...`);
      expect(page.entries[0]?.text).toBe("");
      expect(page.truncated).toBe(true);
    });
  });

  describe("readTranscript", () => {
    it("refuses non-chat sessions even when a transcript file exists", async () => {
      const { service, sessionService } = createService();
      const transcriptPath = path.join(tmpRoot, "transcripts", "terminal-session.chat.jsonl");
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          sessionId: "terminal-session",
          timestamp: "2026-06-30T12:00:00.000Z",
          event: { type: "user_message", text: "terminal secret" },
          sequence: 1,
        })}\n`,
        "utf8",
      );
      sessionService.create({
        sessionId: "terminal-session",
        laneId: "lane-1",
        toolType: "terminal",
        transcriptPath,
      });
      vi.mocked(parseAgentChatTranscript).mockReturnValue([{
        sessionId: "terminal-session",
        timestamp: "2026-06-30T12:00:00.000Z",
        event: { type: "user_message", text: "terminal secret" },
        sequence: 1,
      }]);

      await expect(service.readTranscript("terminal-session")).resolves.toEqual([]);
      expect(parseAgentChatTranscript).not.toHaveBeenCalled();
    });
  });

  describe("getChatEventHistory", () => {
    it.each([
      ["claude", "claude-chat"],
      ["codex", "codex-chat"],
      ["opencode", "opencode-chat"],
      ["cursor", "cursor"],
      ["droid", "droid-chat"],
    ] as const)("closes an orphaned %s turn when a detached chat hydrates after restart", async (
      provider,
      toolType,
    ) => {
      installRealTranscriptParser();
      const original = createService();
      const session = {
        id: `restart-${provider}-session`,
        transcriptPath: path.join(tmpRoot, "transcripts", `restart-${provider}-session.chat.jsonl`),
      };
      original.sessionService.create({
        sessionId: session.id,
        laneId: "lane-1",
        toolType,
        transcriptPath: session.transcriptPath,
      });
      const turnId = `restart-${provider}-turn`;
      writeTestTranscriptEnvelopes(session.id, [
        {
          sessionId: session.id,
          timestamp: "2026-08-01T04:10:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "This turn was interrupted by a brain restart.",
            turnId,
            messageId: `restart-${provider}-message`,
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-08-01T04:10:00.100Z",
          sequence: 2,
          event: { type: "status", turnStatus: "started", turnId },
        },
      ]);
      original.sessionService.end({ sessionId: session.id, status: "detached" });

      const emitted: AgentChatEventEnvelope[] = [];
      const restarted = createService({
        onEvent: (event: AgentChatEventEnvelope) => emitted.push(event),
      });
      const firstHistory = await restarted.service.getChatEventHistory(session.id);
      const secondHistory = await restarted.service.getChatEventHistory(session.id);

      expect(restarted.sessionService.get(session.id)).toMatchObject({
        status: "running",
        endedAt: null,
      });
      expect(firstHistory.events.filter((entry) =>
        entry.event.type === "system_notice"
        && entry.event.turnId === turnId
        && entry.event.message.includes("ADE restarted")
      )).toHaveLength(1);
      expect(firstHistory.events.filter((entry) =>
        entry.event.type === "status"
        && entry.event.turnId === turnId
        && entry.event.turnStatus === "interrupted"
      )).toHaveLength(1);
      expect(firstHistory.events.filter((entry) =>
        entry.event.type === "done"
        && entry.event.turnId === turnId
        && entry.event.status === "interrupted"
      )).toHaveLength(1);
      expect(secondHistory.events.filter((entry) =>
        entry.event.type === "done" && entry.event.turnId === turnId
      )).toHaveLength(1);
      expect(emitted.filter((entry) =>
        entry.event.type === "done" && entry.event.turnId === turnId
      )).toHaveLength(1);

      restarted.service.forceDisposeAll();
      original.service.forceDisposeAll();
    });

    it("hydrates identical events from a compressed transcript", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-07-01T10:00:00.000Z",
        event: { type: "text", text: "compressed history" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(`${transcriptFile}.gz`, gzipSync(`${JSON.stringify(envelope)}\n`));
      fs.rmSync(transcriptFile, { force: true });
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => raw.includes("compressed history") ? [envelope] : []);

      expect((await service.getChatEventHistory(session.id)).events).toEqual([envelope]);
    });

    it("prefers the plain transcript in a both-exist crash window", async () => {
      const { service, logger } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const plainEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-07-01T10:00:00.000Z",
        event: { type: "text", text: "plain wins" },
        sequence: 1,
      };
      const gzipEnvelope: AgentChatEventEnvelope = {
        ...plainEnvelope,
        event: { type: "text", text: "gzip loses" },
      };
      const transcriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(plainEnvelope)}\n`);
      fs.writeFileSync(`${transcriptFile}.gz`, gzipSync(`${JSON.stringify(gzipEnvelope)}\n`));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => raw.includes("plain wins") ? [plainEnvelope] : [gzipEnvelope]);

      expect((await service.getChatEventHistory(session.id)).events).toEqual([plainEnvelope]);
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.transcript_plain_preferred",
        expect.objectContaining({ path: expect.stringContaining(`${session.id}.jsonl`) }),
      );
    });

    it("returns an empty history for an unknown session", async () => {
      const { service } = createService();
      const history = await service.getChatEventHistory("unknown-session");
      expect(history.events).toEqual([]);
      expect(history.truncated).toBe(false);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.windowTruncated).toBe(false);
      expect(history.sessionFound).toBe(false);
    });

    it("hydrates history from the on-disk transcript on first read", async () => {
      // This is the core contract that fixes chat-history-loss on project
      // switch / tab switch: a late subscriber that missed the live broadcast
      // still sees persisted recent history, because getChatEventHistory hydrates
      // itself from the transcript the first time the session is queried.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope1: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "persisted-1" },
        sequence: 1,
      };
      const envelope2: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "persisted-2" },
        sequence: 2,
      };

      // Seed the transcript file at the path managed.transcriptPath points
      // to (set by createSession → managedSessions → row.transcriptPath).
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope1, envelope2]);

      const history = await service.getChatEventHistory(session.id);
      expect(history.sessionId).toBe(session.id);
      expect(history.sessionFound).toBe(true);
      expect(history.events).toHaveLength(2);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["persisted-1", "persisted-2"]);
    });

    it("does not copy transcript hydration into the live event ring", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const afterCreate = service.residentChatEventHistorySessionCount();
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-08-12T18:00:00.000Z",
        event: { type: "text", text: "hydrated-from-disk" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);

      const history = await service.getChatEventHistory(session.id);
      expect(history.events.map((entry) =>
        entry.event.type === "text" ? entry.event.text : "",
      )).toContain("hydrated-from-disk");
      expect(service.residentChatEventHistorySessionCount()).toBe(afterCreate);
    });

    it("does not retain a live ring for every hydrated chat", async () => {
      const { service } = createService();
      for (let index = 0; index < 12; index += 1) {
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });
        const envelope: AgentChatEventEnvelope = {
          sessionId: session.id,
          timestamp: "2026-08-12T18:00:00.000Z",
          event: { type: "text", text: `hydrated-${index}` },
          sequence: 1,
        };
        const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
        fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
        vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);
        await service.getChatEventHistory(session.id);
      }
      expect(service.residentChatEventHistorySessionCount()).toBe(0);
    });

    it("hydrates through the async path without synchronous realpath or transcript flushing", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "async-persisted" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);
      const realpathSyncSpy = vi.spyOn(fs, "realpathSync").mockImplementation(() => {
        throw new Error("synchronous realpath is forbidden");
      });
      try {
        const history = await service.getChatEventHistory(session.id);
        expect(history.events).toEqual([envelope]);
      } finally {
        realpathSyncSpy.mockRestore();
      }
    });

    it("keeps async transcript hydration retryable when a candidate cannot be read", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify({
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "persisted" },
        sequence: 1,
      })}\n`, "utf8");
      const openError = Object.assign(new Error("too many open files"), { code: "EMFILE" });
      const openSpy = vi.spyOn(fs.promises, "open").mockRejectedValueOnce(openError);
      try {
        await expect(service.getChatEventHistory(session.id)).rejects.toBe(openError);
      } finally {
        openSpy.mockRestore();
      }
    });

    it("uses a healthy dedicated transcript when a lower-priority legacy candidate fails", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const dedicatedPath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      const legacyPath = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "dedicated survives" },
        sequence: 1,
      };
      fs.writeFileSync(dedicatedPath, `${JSON.stringify(envelope)}\n`, "utf8");
      fs.writeFileSync(legacyPath, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated survives") ? [envelope] : []);
      const legacyError = Object.assign(new Error("legacy read failed"), { code: "EIO" });
      const originalOpen = fs.promises.open.bind(fs.promises);
      const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (
        filePath: fs.PathLike,
        flags: fs.OpenMode,
        mode?: fs.Mode,
      ) => {
        if (String(filePath) === legacyPath) throw legacyError;
        return await originalOpen(filePath, flags, mode);
      }) as typeof fs.promises.open);

      try {
        const history = await service.getChatEventHistory(session.id);
        expect(history.events).toEqual([envelope]);
      } finally {
        openSpy.mockRestore();
      }
    });

    it("hydrates from the more complete dedicated chat transcript when the legacy transcript is capped", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const cappedLegacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-before-cap" },
        sequence: 1,
      };
      const dedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "dedicated-after-cap" },
        sequence: 2,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(cappedLegacyEnvelope)}\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n`,
        "utf8",
      );
      fs.writeFileSync(
        dedicatedTranscriptFile,
        `${JSON.stringify(cappedLegacyEnvelope)}\n${JSON.stringify(dedicatedEnvelope)}\n`,
        "utf8",
      );
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:01:00.000Z"), new Date("2026-04-23T10:01:00.000Z"));
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:02:00.000Z"), new Date("2026-04-23T10:02:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-after-cap")
          ? [cappedLegacyEnvelope, dedicatedEnvelope]
          : [cappedLegacyEnvelope],
      );

      const history = await service.getChatEventHistory(session.id);

      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["legacy-before-cap", "dedicated-after-cap"]);
    });

    it("hydrates from the uncapped dedicated chat transcript when the capped legacy transcript is newer", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const cappedLegacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-capped-boundary" },
        sequence: 1,
      };
      const dedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "dedicated-uncapped-boundary" },
        sequence: 1,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(cappedLegacyEnvelope)}\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n`,
        "utf8",
      );
      fs.writeFileSync(dedicatedTranscriptFile, `${JSON.stringify(dedicatedEnvelope)}\n`, "utf8");
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:00:00.000Z"), new Date("2026-04-23T10:00:00.000Z"));
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:02:00.000Z"), new Date("2026-04-23T10:02:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-uncapped-boundary")
          ? [dedicatedEnvelope]
          : [cappedLegacyEnvelope],
      );

      const history = await service.getChatEventHistory(session.id);

      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["dedicated-uncapped-boundary"]);
    });

    it("hydrates from the legacy transcript when the newest dedicated transcript has only a header", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const legacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-chat-event" },
        sequence: 1,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(legacyTranscriptFile, `${JSON.stringify(legacyEnvelope)}\n`, "utf8");
      fs.writeFileSync(
        dedicatedTranscriptFile,
        `${JSON.stringify({ type: "session_init", sessionId: session.id })}\n`,
        "utf8",
      );
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:00:00.000Z"), new Date("2026-04-23T10:00:00.000Z"));
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:05:00.000Z"), new Date("2026-04-23T10:05:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("legacy-chat-event") ? [legacyEnvelope] : [],
      );

      const history = await service.getChatEventHistory(session.id);

      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["legacy-chat-event"]);
    });

    it("hydrates from the newer dedicated chat transcript even when compacted storage makes it smaller", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const staleLegacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-stale-large" },
        sequence: 1,
      };
      const newerDedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "dedicated-newer-compacted" },
        sequence: 2,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(staleLegacyEnvelope)}\n${"raw-legacy-padding\n".repeat(4096)}`,
        "utf8",
      );
      fs.writeFileSync(
        dedicatedTranscriptFile,
        `${JSON.stringify(newerDedicatedEnvelope)}\n`,
        "utf8",
      );
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:00:00.000Z"), new Date("2026-04-23T10:00:00.000Z"));
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:01:00.000Z"), new Date("2026-04-23T10:01:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-newer-compacted")
          ? [newerDedicatedEnvelope]
          : [staleLegacyEnvelope],
      );

      const history = await service.getChatEventHistory(session.id);

      expect(fs.statSync(legacyTranscriptFile).size).toBeGreaterThan(fs.statSync(dedicatedTranscriptFile).size);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["dedicated-newer-compacted"]);
    });

    it("bounds oversized transcript hydration before parsing", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const oldEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T09:59:00.000Z",
        event: { type: "text", text: "old-head" },
        sequence: 1,
      };
      const recentEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "recent-tail" },
        sequence: 2,
      };

      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const hugeMiddleEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "x".repeat(2_100_000) },
        sequence: 2,
      };
      fs.writeFileSync(
        transcriptFile,
        [
          JSON.stringify(oldEnvelope),
          JSON.stringify(hugeMiddleEnvelope),
          JSON.stringify(recentEnvelope),
          "",
        ].join("\n"),
        "utf8",
      );
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => {
        if (!raw.includes("recent-tail") && !raw.includes("old-head")) return [];
        expect(raw.length).toBeLessThan(50_000);
        expect(raw).toContain("recent-tail");
        expect(raw).not.toContain("old-head");
        return [recentEnvelope];
      });

      const history = await service.getChatEventHistory(session.id);

      expect(history.truncated).toBe(true);
      expect(history.transcriptTruncated).toBe(true);
      expect(history.windowTruncated).toBe(false);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["recent-tail"]);
    });

    it("separates max-event window truncation from transcript-tail truncation", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelopes: AgentChatEventEnvelope[] = Array.from({ length: 5 }, (_, index) => ({
        sessionId: session.id,
        timestamp: `2026-04-23T10:0${index}:00.000Z`,
        event: { type: "text", text: `event-${index}` },
        sequence: index + 1,
      }));
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(envelopes);

      const history = await service.getChatEventHistory(session.id, { maxEvents: 3 });

      expect(history.truncated).toBe(true);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.windowTruncated).toBe(true);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["event-2", "event-3", "event-4"]);
    });

    it("byte-caps a snapshot whose merged events exceed the response budget", async () => {
      // Regression: individual chat events can carry multi-MB tool outputs.
      // Event-count caps alone let a snapshot serialize past the desktop RPC
      // client's 16 MiB per-message limit, which used to fail every in-flight
      // call on the shared runtime socket.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelopes: AgentChatEventEnvelope[] = Array.from({ length: 4 }, (_, index) => ({
        sessionId: session.id,
        timestamp: `2026-04-23T10:0${index}:00.000Z`,
        event: { type: "text", text: `event-${index}-${"x".repeat(3_000_000)}` },
        sequence: index + 1,
      }));
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(envelopes);

      const history = await service.getChatEventHistory(session.id);

      // 4 × ~3 MB events exceed the 8 MB response budget: only the newest
      // events that fit are returned, and the trim is reported as window
      // truncation so clients know to page for the rest.
      expect(history.events.length).toBeLessThan(envelopes.length);
      expect(history.events.length).toBeGreaterThan(0);
      expect(history.windowTruncated).toBe(true);
      expect(history.truncated).toBe(true);
      expect(JSON.stringify(history.events).length).toBeLessThanOrEqual(8_000_000);
      const lastEvent = history.events.at(-1)?.event;
      expect(lastEvent?.type === "text" ? lastEvent.text.startsWith("event-3-") : false).toBe(true);
    });

    it("always returns at least the newest event even when it alone exceeds the byte budget", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const giant: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "giant-".concat("y".repeat(9_000_000)) },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([giant]);

      const history = await service.getChatEventHistory(session.id);
      expect(history.events).toHaveLength(1);
    });

    it("drops an oversized newest event when a strict mobile byte budget is requested", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const giant: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "giant-".concat("y".repeat(16_000)) },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([giant]);

      const history = await service.getChatEventHistory(session.id, { maxBytes: 8_192 });

      expect(history.events).toHaveLength(0);
      expect(history.windowTruncated).toBe(true);
      expect(history.truncated).toBe(true);
    });

    it("marks window truncation when the service response cap removes events", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelopes: AgentChatEventEnvelope[] = Array.from({ length: 20_001 }, (_, index) => ({
        sessionId: session.id,
        timestamp: new Date(Date.UTC(2026, 3, 23, 10, 0, index)).toISOString(),
        event: { type: "text", text: `event-${index}` },
        sequence: index + 1,
      }));
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(envelopes);

      const history = await service.getChatEventHistory(session.id);

      expect(history.events).toHaveLength(20_000);
      expect(history.truncated).toBe(true);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.windowTruncated).toBe(true);
      expect(history.events[0]?.event).toMatchObject({ type: "text", text: "event-1" });
    });

    it("reuses an unchanged parsed transcript tail across repeated history snapshots", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "persisted-once" },
        sequence: 1,
      };

      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockClear();
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("persisted-once") ? [envelope] : [],
      );

      const firstHistory = await service.getChatEventHistory(session.id);
      const secondHistory = await service.getChatEventHistory(session.id);

      expect(firstHistory.events).toHaveLength(1);
      expect(secondHistory.events).toHaveLength(1);
      expect(parseAgentChatTranscript).toHaveBeenCalledTimes(2);
    });

    it("re-reads the on-disk transcript on repeated history snapshots", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope1: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "persisted-before-switch" },
        sequence: 1,
      };
      const envelope2: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "persisted-after-switch" },
        sequence: 2,
      };

      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => {
        if (raw.includes("persisted-after-switch")) return [envelope1, envelope2];
        if (raw.includes("persisted-before-switch")) return [envelope1];
        return [];
      });

      const firstHistory = await service.getChatEventHistory(session.id);
      expect(firstHistory.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["persisted-before-switch"]);

      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}\n`, "utf8");

      const secondHistory = await service.getChatEventHistory(session.id);
      expect(secondHistory.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["persisted-before-switch", "persisted-after-switch"]);
    });

    it("keeps Claude streaming fragments that share a timestamp when hydrating", async () => {
      // Claude SDK emits multiple text deltas inside tight streaming loops,
      // so two legitimate envelopes with type:"text" can land on the same
      // millisecond. A naive timestamp+type dedup key would collapse these;
      // the cross-run-safe dedup must keep distinct payloads separate.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const sharedTimestamp = new Date().toISOString();
      const envelope1: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: sharedTimestamp,
        event: { type: "text", text: "fragment-a" },
        sequence: 1,
      };
      const envelope2: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: sharedTimestamp,
        event: { type: "text", text: "fragment-b" },
        sequence: 2,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope1, envelope2]);

      const history = await service.getChatEventHistory(session.id);
      expect(history.events).toHaveLength(2);
      expect(history.events.map((e) => e.event.type === "text" ? e.event.text : "")).toEqual([
        "fragment-a",
        "fragment-b",
      ]);
    });

    it("does not hydrate transcript symlinks that resolve outside ADE", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "outside-transcript" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const outsideTranscriptPath = path.join(tmpHomeRoot, "outside-transcript.jsonl");
      fs.writeFileSync(outsideTranscriptPath, `${JSON.stringify(envelope)}\n`, "utf8");
      fs.rmSync(transcriptFile, { force: true });
      fs.rmSync(path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`), { force: true });
      fs.symlinkSync(outsideTranscriptPath, transcriptFile);
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);

      const history = await service.getChatEventHistory(session.id);

      expect(history.events).toEqual([]);
      expect(parseAgentChatTranscript).not.toHaveBeenCalled();
    });

    it("drops history when the underlying session is deleted", async () => {
      // We don't rely on sendMessage emitting events (mock streams vary across
      // providers), so we seed the transcript directly to verify the cleanup
      // path. deleteSession must remove both the in-memory ring buffer and
      // any hydrated-from-disk state so a subsequently-created session with
      // the same id doesn't inherit stale events.
      const emitted: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => emitted.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      // Seed the transcript on disk and populate the hydrated-from-disk cache
      // BEFORE deleting, so a regression where deleteSession fails to clear
      // the cache would actually be caught (an empty history trivially stays
      // empty).
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "before-delete" },
        sequence: 1,
      };
      // The legacy transcript is newer than the session_init-only dedicated
      // transcript, so hydration reads this seeded file.
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);
      const beforeDelete = await service.getChatEventHistory(session.id);
      expect(beforeDelete.events).toHaveLength(1);

      await service.deleteSession({ sessionId: session.id });

      // The transcript-returning parser mock is still wired up, so if
      // deleteSession fails to clear the cache / on-disk file, the next read
      // would still surface envelopes. An empty result proves both the
      // in-memory ring buffer and the hydrated state were cleared.
      const afterDelete = await service.getChatEventHistory(session.id);
      expect(afterDelete.events).toEqual([]);
      expect(afterDelete.truncated).toBe(false);
      expect(afterDelete.sessionFound).toBe(false);
    });

    describe("hasOlderHistory / tailStartOffset derivation", () => {
      // The scroll-back cursor used to be derived purely from envelope OBJECT
      // IDENTITY (a WeakMap on the parsed transcript envelopes). Whenever the
      // returned events came from the in-memory ring buffer — or were re-created
      // by the coalescing/subagent pipeline — every identity lookup missed and
      // the snapshot fell back to an end-of-file cursor, which the renderer read
      // as "older pages exist" and rendered a false "couldn't load earlier
      // messages" head slot. `hasOlderHistory` is derived from the tail READ
      // instead, so it survives identity loss.
      const LINE_BYTES = 1_000;
      const fixedWidthLine = (envelope: AgentChatEventEnvelope, exactBytes: number): string => {
        const baseEvent = envelope.event as { type: "text"; text: string };
        const padding = exactBytes - Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8");
        if (padding < 0) throw new Error("fixture line too large");
        const line = `${JSON.stringify({
          ...envelope,
          event: { ...baseEvent, text: baseEvent.text + "x".repeat(padding) },
        })}\n`;
        expect(Buffer.byteLength(line, "utf8")).toBe(exactBytes);
        return line;
      };
      // 4 fixed-width lines: a 1_024-byte tail read lands exactly on the line-3
      // boundary at byte 3_000, and the file ends at byte 4_000.
      const fourLineTranscript = (sessionId: string): string =>
        Array.from({ length: 4 }, (_, index) => fixedWidthLine({
          sessionId,
          timestamp: new Date(Date.UTC(2026, 3, 23, 10, 0, index)).toISOString(),
          event: { type: "text", text: `line-${index}-` },
          sequence: index,
        }, LINE_BYTES)).join("");

      // Seed the in-memory ring with envelope objects, then leave the parser
      // returning nothing for any later read — the state where every identity
      // lookup misses because the response is ring-buffer-only.
      const seedRingThenLoseIdentity = async (
        service: ReturnType<typeof createService>["service"],
        sessionId: string,
        transcriptFile: string,
        seeded: AgentChatEventEnvelope[],
      ): Promise<void> => {
        fs.writeFileSync(transcriptFile, `${seeded.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
        vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
          raw.includes("ring-seed") ? seeded : []);
        service.seedLiveChatEventHistory(seeded);
        expect((await service.getChatEventHistory(sessionId)).events).toHaveLength(seeded.length);
      };

      const ringEnvelope = (sessionId: string, index: number): AgentChatEventEnvelope => ({
        sessionId,
        timestamp: new Date(Date.UTC(2026, 3, 23, 11, 0, index)).toISOString(),
        event: { type: "text", text: `ring-seed-${index}` },
        sequence: 100 + index,
      });

      it("reports no older history when the tail read started at byte 0 and identity was lost", async () => {
        const { service } = createService();
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
        const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
        await seedRingThenLoseIdentity(service, session.id, transcriptFile, [ringEnvelope(session.id, 0)]);

        // Non-empty transcript (endOffset > 0) that the parser yields nothing
        // for, so the snapshot is served entirely from the ring buffer.
        fs.writeFileSync(transcriptFile, '{"opaque":true}\n'.repeat(8), "utf8");

        const history = await service.getChatEventHistory(session.id);

        expect(history.events).toHaveLength(1);
        expect(history.transcriptTruncated).toBe(false);
        expect(history.windowTruncated).toBe(false);
        expect(history.hasOlderHistory).toBe(false);
        expect(history.tailStartOffset ?? null).toBeNull();
      });

      it("pages from the tail read's startOffset when identity was lost but nothing was windowed out", async () => {
        const { service } = createService();
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
        const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
        const seeded = ringEnvelope(session.id, 0);
        await seedRingThenLoseIdentity(service, session.id, transcriptFile, [seeded]);

        fs.writeFileSync(transcriptFile, fourLineTranscript(session.id), "utf8");

        const history = await service.getChatEventHistory(session.id, { maxBytes: 1_024 });

        // Every merged event was returned, so everything at/after the tail
        // read's startOffset is already in the response: paging older from
        // startOffset is exact, not conservative.
        expect(history.events).toEqual([seeded]);
        expect(history.transcriptTruncated).toBe(true);
        expect(history.windowTruncated).toBe(false);
        expect(history.hasOlderHistory).toBe(true);
        expect(history.tailStartOffset).toBe(3 * LINE_BYTES);
      });

      it("keeps the conservative end-of-file cursor when identity was lost AND the window dropped events", async () => {
        const { service } = createService();
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
        const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
        const seeded = [0, 1, 2].map((index) => ringEnvelope(session.id, index));
        await seedRingThenLoseIdentity(service, session.id, transcriptFile, seeded);

        fs.writeFileSync(transcriptFile, fourLineTranscript(session.id), "utf8");

        const history = await service.getChatEventHistory(session.id, { maxEvents: 1, maxBytes: 1_024 });

        expect(history.events).toEqual([seeded[2]]);
        expect(history.windowTruncated).toBe(true);
        expect(history.hasOlderHistory).toBe(true);
        // Degraded but recoverable: without this fallback a truncated transcript
        // whose snapshot came from the ring buffer could never be scrolled back.
        expect(history.tailStartOffset).toBe(4 * LINE_BYTES);
      });

      it("reports hasOlderHistory:false for an unknown session", async () => {
        const { service } = createService();
        const history = await service.getChatEventHistory("unknown-session");
        expect(history.hasOlderHistory).toBe(false);
      });
    });
  });

  describe("chatLogV2 history", () => {
    const paddedTextEnvelope = (sessionId: string, sequence: number, exactBytes: number): AgentChatEventEnvelope => {
      const base: AgentChatEventEnvelope = {
        sessionId,
        timestamp: new Date(Date.UTC(2026, 8, 23, 10, 0, sequence)).toISOString(),
        sequence,
        event: { type: "text", text: `t${sequence}-`, turnId: "turn-2" },
      };
      const padding = exactBytes - Buffer.byteLength(JSON.stringify(base), "utf8");
      if (padding < 0) throw new Error("fixture too small");
      return { ...base, event: { type: "text", text: `t${sequence}-${"x".repeat(padding)}`, turnId: "turn-2" } };
    };

    const seedTurnFixture = (sessionId: string): AgentChatEventEnvelope[] => {
      const approval = {
        sessionId,
        timestamp: "2026-09-23T09:59:00.000Z",
        sequence: 1,
        event: {
          type: "approval_request",
          itemId: "approval-old",
          kind: "command",
          description: "Run the migration",
          turnId: "turn-1",
        },
      } as AgentChatEventEnvelope;
      const user: AgentChatEventEnvelope = {
        sessionId,
        timestamp: "2026-09-23T10:00:00.000Z",
        sequence: 2,
        event: { type: "user_message", text: "Keep going", turnId: "turn-2" },
      };
      const texts = [3, 4, 5, 6, 7, 8].map((sequence) => paddedTextEnvelope(sessionId, sequence, 250));
      const envelopes = [approval, user, ...texts];
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${sessionId}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(envelopes);
      return envelopes;
    };

    it("cuts a byte-capped snapshot at the turn boundary and reports old approvals separately", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      seedTurnFixture(session.id);

      // Legacy shape: natural cut mid-turn, old approval spliced back in.
      const legacy = await service.getChatEventHistory(session.id, { maxBytes: 1_024 });
      expect(legacy.events.map((entry) => entry.sequence)).toEqual([1, 5, 6, 7, 8]);
      expect(legacy.pinnedEvents).toBeUndefined();

      const aligned = await service.getChatEventHistory(session.id, {
        maxBytes: 1_024,
        turnBoundaryAligned: true,
        separatePinnedEvents: true,
      });
      // Back to the user message that started the turn (650 extra bytes ≤ 1× budget).
      expect(aligned.events.map((entry) => entry.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8]);
      expect(aligned.pinnedEvents?.map((entry) => entry.event.type)).toEqual(["approval_request"]);
      expect(aligned.hasOlderHistory).toBe(true);
    });

    it("keeps the natural cut when the turn boundary is more than one budget away", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const user: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-09-23T10:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "Long turn", turnId: "turn-1" },
      };
      const texts = Array.from({ length: 12 }, (_, index) => paddedTextEnvelope(session.id, index + 2, 250));
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([user, ...texts]);

      const aligned = await service.getChatEventHistory(session.id, {
        maxBytes: 1_024,
        turnBoundaryAligned: true,
        separatePinnedEvents: true,
      });
      expect(aligned.events.map((entry) => entry.sequence)).toEqual([10, 11, 12, 13]);
      expect(aligned.pinnedEvents).toEqual([]);
    });

    it("reports the chat log state: generation 1 and the live sequence high-water", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const state = service.getChatLogState(session.id);
      expect(state?.historyGeneration).toBe(1);
      expect(typeof state?.maxSequence).toBe("number");
      expect(service.getChatLogState("not-a-chat")).toBeNull();
      await service.dispose({ sessionId: session.id });
      // Disposed: answered from persisted state.
      expect(service.getChatLogState(session.id)?.historyGeneration).toBe(1);
    });

    it("pages older history by sequence cursor", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const envelopes = Array.from({ length: 6 }, (_, index) => paddedTextEnvelope(session.id, index + 1, 300));
      const raw = envelopes.map((envelope) => `${JSON.stringify(envelope)}\n`).join("");
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), raw, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation((text) => String(text)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AgentChatEventEnvelope));

      const page = await service.getChatEventHistoryPage(session.id, { beforeOffset: 0, beforeSequence: 4 });
      expect(page.sessionFound).toBe(true);
      expect(page.events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
      expect(page.hasMore).toBe(false);
      const head = await service.getChatEventHistoryPage(session.id, { beforeOffset: 0, beforeSequence: 1 });
      expect(head.events).toEqual([]);
    });
  });

  describe("getChatEventHistoryPage", () => {
    // Byte-window edge cases (line-boundary cursors, oversized lines,
    // multi-byte UTF-8, concurrent appends) are covered with the REAL parser
    // in chatTranscriptHistoryPager.test.ts; these tests cover the service
    // contract around it: session validation, path resolution, subagent
    // filtering, and the tailStartOffset cursor handshake.
    const jsonLineParse = (raw: string): AgentChatEventEnvelope[] =>
      raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as AgentChatEventEnvelope);

    const paddedLine = (envelope: AgentChatEventEnvelope, exactBytes: number): string => {
      const baseEvent = envelope.event as { type: "text"; text: string };
      let line = `${JSON.stringify(envelope)}\n`;
      const padding = exactBytes - Buffer.byteLength(line, "utf8");
      if (padding < 0) throw new Error("fixture line too large");
      line = `${JSON.stringify({ ...envelope, event: { ...baseEvent, text: baseEvent.text + "x".repeat(padding) } })}\n`;
      expect(Buffer.byteLength(line, "utf8")).toBe(exactBytes);
      return line;
    };

    it("returns sessionFound:false for unknown sessions", async () => {
      const { service } = createService();
      const page = await service.getChatEventHistoryPage("unknown-session", { beforeOffset: 1_000 });
      expect(page).toEqual({
        sessionId: "unknown-session",
        events: [],
        startOffset: 0,
        hasMore: false,
        sessionFound: false,
      });
    });

    it("returns an empty head-reached page for beforeOffset <= 0", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      for (const beforeOffset of [0, -25]) {
        const page = await service.getChatEventHistoryPage(session.id, { beforeOffset });
        expect(page.sessionFound).toBe(true);
        expect(page.events).toEqual([]);
        expect(page.hasMore).toBe(false);
        expect(page.startOffset).toBe(0);
      }
    });

    it("returns an empty page when the transcript file is missing", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      fs.rmSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), { force: true });
      const page = await service.getChatEventHistoryPage(session.id, { beforeOffset: 5_000 });
      expect(page.sessionFound).toBe(true);
      expect(page.events).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.startOffset).toBe(0);
    });

    it("keeps transcript paging retryable when a resolved file cannot be read", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "persisted" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const raw = `${JSON.stringify(envelope)}\n`;
      fs.writeFileSync(transcriptFile, raw, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation(jsonLineParse);
      await service.getChatEventHistory(session.id);

      const openError = Object.assign(new Error("too many open files"), { code: "EMFILE" });
      const openSpy = vi.spyOn(fs.promises, "open").mockRejectedValueOnce(openError);
      try {
        await expect(service.getChatEventHistoryPage(session.id, {
          beforeOffset: Buffer.byteLength(raw, "utf8"),
        })).rejects.toBe(openError);
      } finally {
        openSpy.mockRestore();
      }
    });

    it("reads the requested byte window and filters Codex subagent envelopes", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      const parentEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "parent-visible" },
        sequence: 1,
      };
      const subagentEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:01.000Z",
        event: { type: "text", text: "subagent-hidden" },
        sequence: 2,
        provenance: { targetKind: "codex_subagent" },
      };
      const otherSessionEnvelope: AgentChatEventEnvelope = {
        sessionId: "other-session",
        timestamp: "2026-06-10T10:00:02.000Z",
        event: { type: "text", text: "foreign" },
        sequence: 3,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const raw = [parentEnvelope, subagentEnvelope, otherSessionEnvelope]
        .map((entry) => `${JSON.stringify(entry)}\n`).join("");
      fs.writeFileSync(transcriptFile, raw, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation(jsonLineParse);

      const page = await service.getChatEventHistoryPage(session.id, {
        beforeOffset: Buffer.byteLength(raw, "utf8"),
      });
      expect(page.sessionFound).toBe(true);
      expect(page.events.map((entry) => (entry.event.type === "text" ? entry.event.text : ""))).toEqual([
        "parent-visible",
      ]);
      expect(page.startOffset).toBe(0);
      expect(page.hasMore).toBe(false);
    });

    it("hands out a tailStartOffset that pages seamlessly into the bytes the tail skipped", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      // 82 lines × 25_000 bytes = 2_050_000 bytes — 50_000 bytes older than the
      // 2_000_000-byte hydration tail, i.e. exactly the first two lines.
      const LINE_BYTES = 25_000;
      const LINE_COUNT = 82;
      const lines: string[] = [];
      for (let index = 0; index < LINE_COUNT; index += 1) {
        lines.push(paddedLine({
          sessionId: session.id,
          timestamp: new Date(Date.UTC(2026, 5, 10, 10, 0, index)).toISOString(),
          event: { type: "text", text: `line-${index}-` },
          sequence: index,
        }, LINE_BYTES));
      }
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, lines.join(""), "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation(jsonLineParse);

      const history = await service.getChatEventHistory(session.id);
      expect(history.transcriptTruncated).toBe(true);
      // The tail window starts exactly at line 2 (a line boundary).
      expect(history.tailStartOffset).toBe(2 * LINE_BYTES);
      expect(history.events[0]?.event).toMatchObject({ type: "text" });
      expect((history.events[0]?.event as { text: string }).text.startsWith("line-2-")).toBe(true);

      const page = await service.getChatEventHistoryPage(session.id, { beforeOffset: history.tailStartOffset! });
      expect(page.sessionFound).toBe(true);
      expect(page.events.map((entry) => (entry.event.type === "text" ? entry.event.text.split("x")[0] : ""))).toEqual([
        "line-0-",
        "line-1-",
      ]);
      expect(page.startOffset).toBe(0);
      expect(page.hasMore).toBe(false);
    });

    it("pages identical UTF-8 transcript rows by occurrence without skipping the older duplicate", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const duplicate: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "héllo-🙂-漢字" },
        sequence: 1,
      };
      const line = `${JSON.stringify(duplicate)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      expect(lineBytes).toBeGreaterThan(line.length);

      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${line}${line}`, "utf8");

      const history = await service.getChatEventHistory(session.id, { maxEvents: 1 });
      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.event).toEqual(duplicate.event);
      expect(history.tailStartOffset).toBe(lineBytes);

      const page = await service.getChatEventHistoryPage(session.id, {
        beforeOffset: history.tailStartOffset!,
      });
      expect(page.events).toHaveLength(1);
      expect(page.events[0]?.event).toEqual(duplicate.event);
      expect(page.startOffset).toBe(0);
      expect(page.hasMore).toBe(false);
    });

    it("keeps a requested-byte snapshot seamless with its older page and unflushed ring events", async () => {
      installRealTranscriptParser();
      const emitted: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => emitted.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      // Create a normal committed event, then replace the files beneath it so
      // the ring is one append ahead of the transcript snapshot (the same
      // state as an fs.appendFile still in flight).
      const pendingInput = service.requestChatInput({
        chatSessionId: session.id,
        title: "Live ring event",
        body: "Choose one",
        questions: [{
          id: "choice",
          question: "Choose one",
          options: [{ label: "One" }, { label: "Two" }],
        }],
      });
      const liveRingEvent = await waitForEvent(
        emitted,
        (entry): entry is Omit<AgentChatEventEnvelope, "event"> & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => entry.event.type === "approval_request",
      );

      const LINE_BYTES = 16 * 1024;
      const LINE_COUNT = 24;
      const lines = Array.from({ length: LINE_COUNT }, (_, index) => paddedLine({
        sessionId: session.id,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        event: { type: "text", text: `persisted-${index}-` },
        sequence: index,
      }, LINE_BYTES));
      const raw = lines.join("");
      const legacyTranscript = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const durableTranscript = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.mkdirSync(path.dirname(legacyTranscript), { recursive: true });
      fs.mkdirSync(path.dirname(durableTranscript), { recursive: true });
      fs.writeFileSync(legacyTranscript, raw, "utf8");
      fs.writeFileSync(durableTranscript, raw, "utf8");

      const maxBytes = 128 * 1024;
      const history = await service.getChatEventHistory(session.id, { maxEvents: 512, maxBytes });
      expect(history.events).toContainEqual(liveRingEvent);
      expect(history.tailStartOffset).toEqual(expect.any(Number));
      expect(history.tailStartOffset).toBeGreaterThan(0);
      expect(history.events.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"),
        0,
      )).toBeLessThanOrEqual(maxBytes);

      const snapshotSequences = history.events.flatMap((entry) =>
        typeof entry.sequence === "number" && entry.event.type === "text" ? [entry.sequence] : []);
      expect(snapshotSequences.length).toBeGreaterThan(0);
      const firstSnapshotSequence = snapshotSequences[0]!;
      expect(history.tailStartOffset).toBe(firstSnapshotSequence * LINE_BYTES);

      const page = await service.getChatEventHistoryPage(session.id, {
        beforeOffset: history.tailStartOffset!,
        maxBytes,
      });
      const pageSequences = page.events.flatMap((entry) =>
        typeof entry.sequence === "number" && entry.event.type === "text" ? [entry.sequence] : []);
      expect(pageSequences.at(-1)).toBe(firstSnapshotSequence - 1);
      expect(new Set([...pageSequences, ...snapshotSequences]).size)
        .toBe(pageSequences.length + snapshotSequences.length);

      await service.respondToInput({
        sessionId: session.id,
        itemId: liveRingEvent.event.itemId,
        decision: "decline",
      });
      await pendingInput;
    });

    it("keeps small snapshots and older pages on one deterministic transcript", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      const LINE_BYTES = 8 * 1024;
      const durableTargetCount = 8;
      const durableLines = [
        ...Array.from({ length: durableTargetCount }, (_, index) => paddedLine({
          sessionId: session.id,
          timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
          event: { type: "text", text: `durable-${index}-` },
          sequence: index,
        }, LINE_BYTES)),
        // More than 128 KiB of unrelated trailing data makes the small
        // hydration probe see no events for this session, while the fixed
        // 2 MiB identity probe still sees the durable target history.
        ...Array.from({ length: 18 }, (_, index) => paddedLine({
          sessionId: "other-session",
          timestamp: new Date(Date.UTC(2026, 0, 2, 1, 0, index)).toISOString(),
          event: { type: "text", text: `foreign-${index}-` },
          sequence: 1_000 + index,
        }, LINE_BYTES)),
      ];
      const legacyLines = Array.from({ length: 20 }, (_, index) => paddedLine({
        sessionId: session.id,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        event: { type: "text", text: `legacy-${index}-` },
        sequence: 2_000 + index,
      }, LINE_BYTES));

      const legacyTranscript = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const durableTranscript = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.mkdirSync(path.dirname(legacyTranscript), { recursive: true });
      fs.mkdirSync(path.dirname(durableTranscript), { recursive: true });
      fs.writeFileSync(legacyTranscript, legacyLines.join(""), "utf8");
      fs.writeFileSync(durableTranscript, durableLines.join(""), "utf8");
      fs.utimesSync(legacyTranscript, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
      fs.utimesSync(durableTranscript, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockClear();

      const maxBytes = 128 * 1024;
      const history = await service.getChatEventHistory(session.id, { maxEvents: 512, maxBytes });
      // The 128 KiB hydration probe returns no events for this session (its
      // tail is all foreign rows), so no returned envelope can supply a cursor.
      // Nothing was dropped from the merge window either, so the cursor is the
      // tail read's own line-boundary start — everything for this session
      // at/after it is already accounted for. The line width divides the probe
      // exactly, so that start is `size - maxBytes`.
      expect(history.tailStartOffset).toBe(Buffer.byteLength(durableLines.join(""), "utf8") - maxBytes);
      expect(history.hasOlderHistory).toBe(true);
      expect(history.events.some((entry) =>
        entry.event.type === "text" && entry.event.text.startsWith("legacy-"),
      )).toBe(false);

      const durableSequences = history.events.flatMap((entry) =>
        entry.event.type === "text" && entry.event.text.startsWith("durable-") && typeof entry.sequence === "number"
          ? [entry.sequence]
          : []);
      let beforeOffset = history.tailStartOffset!;
      while (beforeOffset > 0) {
        const parseCallsBeforePage = vi.mocked(parseAgentChatTranscript).mock.calls.length;
        const page = await service.getChatEventHistoryPage(session.id, { beforeOffset, maxBytes });
        // Candidate ranking reuses both fixed-window cache entries. The only
        // parse here is the page payload itself, rather than synchronously
        // re-reading both candidates on every scroll-back request.
        expect(parseAgentChatTranscript).toHaveBeenCalledTimes(parseCallsBeforePage + 1);
        expect(page.events.some((entry) =>
          entry.event.type === "text" && entry.event.text.startsWith("legacy-"),
        )).toBe(false);
        durableSequences.push(...page.events.flatMap((entry) =>
          entry.event.type === "text" && entry.event.text.startsWith("durable-") && typeof entry.sequence === "number"
            ? [entry.sequence]
            : []));
        expect(page.startOffset).toBeLessThan(beforeOffset);
        beforeOffset = page.startOffset;
      }

      expect(durableSequences.slice().sort((a, b) => a - b)).toEqual(
        Array.from({ length: durableTargetCount }, (_, index) => index),
      );
      expect(new Set(durableSequences).size).toBe(durableSequences.length);
    });

    it("reports a null tailStartOffset when the transcript is fully hydrated", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "small" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation(jsonLineParse);

      const history = await service.getChatEventHistory(session.id);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.tailStartOffset).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Resume and error recovery
  // --------------------------------------------------------------------------

  describe("resumeSession", () => {
    it("resumes a disposed session back to idle", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.dispose({ sessionId: session.id });
      const resumed = await service.resumeSession({ sessionId: session.id });

      expect(resumed.id).toBe(session.id);
      expect(sessionService.reopen).toHaveBeenCalledWith(session.id);
    });

    it("repairs a spliced dedicated envelope transcript before Claude resume", async () => {
      installClaudeResponseFixture({ sdkSessionId: "sdk-splice-repair", responseText: "unused" });
      const initial = createService();
      const session = await initial.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await initial.service.dispose({ sessionId: session.id });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, { ...persisted, sdkSessionId: "sdk-splice-repair" });
      const transcriptPath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      const legacyTranscriptPath = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const fragments = ["Full", " ", "SDK", " ", "answer"];
      const splicedTranscript = `${fragments.map((text, index) => JSON.stringify({
        sessionId: session.id,
        timestamp: "2026-07-10T12:00:00.000Z",
        sequence: index + 1,
        event: {
          type: "text",
          text,
          messageId: `wire-${index + 1}`,
          turnId: "turn-spliced",
        },
      })).join("\n")}\n`;
      fs.writeFileSync(transcriptPath, splicedTranscript, "utf8");
      fs.writeFileSync(legacyTranscriptPath, splicedTranscript, "utf8");
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "assistant",
        uuid: "wire-sdk",
        session_id: "sdk-splice-repair",
        parent_tool_use_id: null,
        message: {
          id: "msg-stable-sdk",
          role: "assistant",
          content: [{ type: "text", text: "Full SDK answer" }],
        },
      }] as any);
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => String(raw)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line)));
      installClaudeResponseFixture({ sdkSessionId: "sdk-splice-repair", responseText: "unused" });

      const repairEvents: AgentChatEventEnvelope[] = [];
      const resumed = createService({
        onEvent: (event: AgentChatEventEnvelope) => repairEvents.push(event),
      });
      await resumed.service.resumeSession({ sessionId: session.id });
      await resumed.service.runSessionTurn({
        sessionId: session.id,
        text: "Continue after resume.",
        timeoutMs: 15_000,
      });
      await vi.waitFor(() => {
        expect(getSessionMessages).toHaveBeenCalledWith("sdk-splice-repair", { dir: fs.realpathSync(tmpRoot) });
      });
      await vi.waitFor(async () => {
        const textEvents = (await resumed.service.getChatEventHistory(session.id)).events
          .filter((entry) => entry.event.type === "text");
        expect(textEvents.find((entry) => entry.event.type === "text" && entry.event.messageId === "msg-stable-sdk")?.event).toMatchObject({
          type: "text",
          text: "Full SDK answer",
          messageId: "msg-stable-sdk",
        });
      });
      expect(fs.existsSync(`${transcriptPath}.splice.bak`)).toBe(true);
      expect(resumed.logger.info).toHaveBeenCalledWith(
        "agent_chat.envelope_splice_repaired",
        expect.objectContaining({ sessionId: session.id, repairedTurns: 1 }),
      );
      // The rewrite renumbered sequences, so the history moves to a new
      // generation — persisted, reported live, and on the invalidation event.
      expect(repairEvents).toContainEqual(expect.objectContaining({
        sessionId: session.id,
        event: { type: "session_meta_updated", historyInvalidated: true, historyGeneration: 2 },
      }));
      expect(resumed.service.getChatLogState(session.id)?.historyGeneration).toBe(2);
      expect(readPersistedChatState(session.id).historyGeneration).toBe(2);
    });

    it("resolves an ADE chat id to persisted and pointer-backed Claude main transcripts", async () => {
      installClaudeResponseFixture({ sdkSessionId: "sdk-main-transcript", responseText: "unused" });
      const { service, sessionService } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.dispose({ sessionId: session.id });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, { ...persisted, sdkSessionId: "sdk-persisted-main" });
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "assistant",
        uuid: "assistant-persisted",
        session_id: "sdk-persisted-main",
        parent_tool_use_id: null,
        message: { id: "msg-persisted", role: "assistant", content: [{ type: "text", text: "Persisted transcript" }] },
      }] as any);

      expect(await service.getMainTranscript({ sessionId: session.id })).toEqual([
        expect.objectContaining({ uuid: "assistant-persisted", text: "Persisted transcript" }),
      ]);
      expect(getSessionMessages).toHaveBeenLastCalledWith("sdk-persisted-main", expect.objectContaining({
        dir: fs.realpathSync(tmpRoot),
        includeSystemMessages: true,
      }));

      const pointerState = { ...persisted };
      delete pointerState.sdkSessionId;
      writePersistedChatState(session.id, pointerState);
      sessionService.upsertClaudeSessionPointer({
        sessionId: "sdk-pointer-main",
        laneId: "lane-1",
        laneName: "Primary",
        chatSessionId: session.id,
        title: null,
        tags: [],
        createdAt: "2026-07-10T12:00:00.000Z",
        updatedAt: "2026-07-10T12:00:00.000Z",
      });
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "system",
        uuid: "system-pointer",
        session_id: "sdk-pointer-main",
        parent_tool_use_id: null,
        message: { role: "system", content: "Pointer transcript" },
      }] as any);

      expect(await service.getMainTranscript({ sessionId: session.id })).toEqual([
        expect.objectContaining({ uuid: "system-pointer", type: "system", text: "Pointer transcript" }),
      ]);
      expect(getSessionMessages).toHaveBeenLastCalledWith("sdk-pointer-main", expect.objectContaining({
        includeSystemMessages: true,
      }));
    });

    it("uses the parent SDK session captured when an older Claude subagent started", async () => {
      installClaudeResponseFixture({ sdkSessionId: "sdk-current", responseText: "unused" });
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        sdkSessionId: "sdk-current",
      });
      const transcriptPath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(transcriptPath, `${JSON.stringify({
        sessionId: session.id,
        timestamp: "2026-07-10T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "task-old",
          agentId: "agent-old",
          providerSessionId: "sdk-old",
          description: "Older child",
        },
      })}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => String(raw)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line)));
      vi.mocked(getSubagentMessages).mockResolvedValue([{
        type: "assistant",
        uuid: "child-old-answer",
        session_id: "sdk-old",
        parent_tool_use_id: "tool-old",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "Historical child answer" }],
        },
      }] as any);

      const result = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "agent-old",
        taskId: "task-old",
      });

      expect(getSubagentMessages).toHaveBeenCalledWith(
        "sdk-old",
        "agent-old",
        expect.objectContaining({ dir: fs.realpathSync(tmpRoot) }),
      );
      expect(result).toEqual([
        expect.objectContaining({
          uuid: "child-old-answer",
          text: "Historical child answer",
          subagentMetadata: expect.objectContaining({
            threadId: "agent-old",
            parentThreadId: "sdk-old",
            model: "claude-opus-5",
          }),
        }),
      ]);
    });

    it("gates main transcripts to Claude and byte-bounds the response", async () => {
      const { service } = createService();
      const codex = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      expect(await service.getMainTranscript({ sessionId: codex.id })).toBeNull();
      expect(getSessionMessages).not.toHaveBeenCalled();

      installClaudeResponseFixture({ sdkSessionId: "sdk-bounded-main", responseText: "unused" });
      const claude = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.dispose({ sessionId: claude.id });
      const persisted = readPersistedChatState(claude.id);
      writePersistedChatState(claude.id, { ...persisted, sdkSessionId: "sdk-bounded-main" });
      const huge = "x".repeat(2_200_000);
      vi.mocked(getSessionMessages).mockResolvedValue([
        { type: "assistant", uuid: "old-huge", session_id: "sdk-bounded-main", parent_tool_use_id: null, message: { role: "assistant", content: huge } },
        { type: "assistant", uuid: "new-huge", session_id: "sdk-bounded-main", parent_tool_use_id: null, message: { role: "assistant", content: huge } },
      ] as any);

      const result = await service.getMainTranscript({ sessionId: claude.id });
      expect(result).toHaveLength(1);
      expect(result?.[0]?.uuid).toBe("new-huge");
    });

    it("keeps requested Codex policy and reasoning effort across resume", async () => {
      mockState.codexResponseOverrides.set("thread/resume", () => ({
        thread: { id: "thread-effective-resume" },
        approvalPolicy: "onFailure",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: "high",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.dispose({ sessionId: session.id });
      const persistedBefore = readPersistedChatState(session.id);
      writePersistedChatState(session.id, {
        ...persistedBefore,
        threadId: "thread-stale-persisted",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
        reasoningEffort: "xhigh",
      });

      const resumed = await service.resumeSession({ sessionId: session.id });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const resumeParams = resumeRequest?.params as {
        config?: { model_reasoning_effort?: unknown };
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
        dynamicTools?: unknown;
        persistExtendedHistory?: unknown;
      } | undefined;
      expect(resumeParams?.config?.model_reasoning_effort).toBe("xhigh");
      expect(resumeParams?.effort).toBeUndefined();
      expect(resumeParams?.reasoningEffort).toBeUndefined();
      expect(resumeParams?.reasoning_effort).toBeUndefined();
      expect(resumeParams?.dynamicTools).toBeUndefined();
      expect(resumeParams?.persistExtendedHistory).toBeUndefined();
      expect(resumed.codexApprovalPolicy).toBe("never");
      expect(resumed.codexSandbox).toBe("danger-full-access");
      expect(resumed.permissionMode).toBe("full-auto");
      expect(resumed.reasoningEffort).toBe("xhigh");

      const persistedAfter = readPersistedChatState(session.id);
      expect(persistedAfter.threadId).toBe("thread-effective-resume");
      expect(persistedAfter.codexApprovalPolicy).toBe("never");
      expect(persistedAfter.codexSandbox).toBe("danger-full-access");
      expect(persistedAfter.reasoningEffort).toBe("xhigh");
    });

    it("throws when resuming an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.resumeSession({ sessionId: "unknown-session-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("preserves Claude SDK session continuity after a runSessionTurn timeout", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let primaryStreamCall = 0;
        let releaseInterruptedTurn = false;
        const primarySend = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const primarySession = {
          send: primarySend,
          stream: vi.fn(() => (async function* () {
            primaryStreamCall += 1;
            if (primaryStreamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-1",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-1",
              message: {
                content: [{ type: "text", text: "Partial answer" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };

            if (primaryStreamCall === 2) {
              while (!releaseInterruptedTurn) {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
              }
              return;
            }

            if (primaryStreamCall === 3) {
              yield {
                type: "assistant",
                session_id: "sdk-session-1",
                message: {
                  content: [{ type: "text", text: "You were asking about the new chat buttons." }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            while (true) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
          })()),
          close: vi.fn(),
          sessionId: "sdk-session-1",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(primarySession as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(primarySession as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });

        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "Add the new chat button",
          timeoutMs: 120_000,
        });
        const firstTurnError = firstTurn
          .then(() => null as Error | null)
          .catch((error) => error instanceof Error ? error : new Error(String(error)));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(events.find((event) =>
          event.event.type === "status" && event.event.turnStatus === "interrupted",
        )).toBeDefined();
        releaseInterruptedTurn = true;
        await vi.advanceTimersByTimeAsync(1_000);
        const timeoutError = await firstTurnError;
        expect(timeoutError?.message ?? "").toMatch(/Timed out waiting for session .* The turn was interrupted, but the chat stayed open\./i);

        const persistedAfterTimeout = readPersistedChatState(session.id);
        expect(persistedAfterTimeout.sdkSessionId).toEqual(expect.any(String));
        const timeoutSdkSessionId = persistedAfterTimeout.sdkSessionId!;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(events.find((event) =>
          event.event.type === "status" && event.event.turnStatus === "failed",
        )).toBeUndefined();

        events.length = 0;
        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "what happened?",
          timeoutMs: 15_000,
        });

        expect(primarySession.close).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(timeoutSdkSessionId, expect.any(Object));
        expect(primarySend).toHaveBeenCalledTimes(3);
        expect(followUp.outputText).toContain("new chat buttons");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not abort Claude turns solely because they run longer than five minutes", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);
        let streamCall = 0;

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-long-running",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            for (let index = 0; index < 6; index += 1) {
              yield {
                type: "assistant",
                session_id: "sdk-session-long-running",
                message: {
                  content: [{ type: "text", text: `Chunk ${index + 1}. ` }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              };
              await new Promise((resolve) => setTimeout(resolve, 60_000));
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-long-running",
              message: {
                content: [{ type: "text", text: "Finished after a long run." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })()),
          close: vi.fn(),
          sessionId: "sdk-session-long-running",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });

        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const turn = service.runSessionTurn({
          sessionId: session.id,
          text: "Keep working until the implementation is done.",
          timeoutMs: 500_000,
        });

        for (let index = 0; index < 6; index += 1) {
          await vi.advanceTimersByTimeAsync(60_000);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await turn;

        expect(result.outputText).toContain("Finished after a long run.");
        expect(events.find((event) => event.event.type === "status" && event.event.turnStatus === "failed")).toBeUndefined();
        expect(events.find((event) => event.event.type === "status" && event.event.turnStatus === "interrupted")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("tears down idle Claude runtimes after the inactivity ttl without losing resume state", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn();
        let streamCall = 0;
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-idle-ttl",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-idle-ttl",
              message: {
                content: [{ type: "text", text: "Done." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })()),
          close,
          sessionId: "sdk-session-idle-ttl",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Say hi",
          timeoutMs: 15_000,
        });

        await vi.advanceTimersByTimeAsync(6 * 60_000);

        expect(close).toHaveBeenCalledTimes(1);
        const persistedAfterIdle = readPersistedChatState(session.id);
        expect(persistedAfterIdle.sdkSessionId).toEqual(expect.any(String));
        const idleSdkSessionId = persistedAfterIdle.sdkSessionId!;
        expect(persistedAfterIdle.lastLaneDirectiveKey).toEqual(expect.any(String));

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Follow up with the previous context",
          timeoutMs: 15_000,
        });

        expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(idleSdkSessionId, expect.any(Object));
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(3);
        expect(String(send.mock.calls[2]?.[0] ?? "")).toContain("Follow up with the previous context");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the OpenCode session pointer across idle_ttl so the next message resumes the same thread", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(streamText).mockImplementation(() => ({
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any));
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "opencode",
          model: "",
          modelId: "opencode/openai/gpt-5.4",
        });

        await service.runSessionTurn({ sessionId: session.id, text: "first" });
        const firstStart = vi.mocked(startOpenCodeSession).mock.calls.at(-1)![0];
        const pointer = readPersistedChatState(session.id).providerSessionId;
        expect(pointer).toEqual(expect.any(String));

        // The idle sweep tears the runtime down. OpenCode keeps its sessions in
        // its own store and re-opens one by id, so this teardown must keep the
        // pointer: before the fix it flagged the runtime invalidated, the next
        // persist dropped the id, and every follow-up message opened a
        // brand-new OpenCode session that had to rediscover the thread.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        expect(readPersistedChatState(session.id).providerSessionId).toBe(pointer);

        await service.runSessionTurn({ sessionId: session.id, text: "second" });
        const secondStart = vi.mocked(startOpenCodeSession).mock.calls.at(-1)![0];
        expect(firstStart.sessionId).toBeUndefined();
        expect(secondStart.sessionId).toBe(pointer);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves Claude resume metadata across idle_ttl followed by shutdown", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn();
        let streamCall = 0;
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-preserve",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }
            yield {
              type: "assistant",
              session_id: "sdk-session-preserve",
              message: {
                content: [{ type: "text", text: "Done." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          })()),
          close,
          sessionId: "sdk-session-preserve",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Say hi",
          timeoutMs: 15_000,
        });

        // Idle-ttl teardown persists sdkSessionId + laneDirectiveKey.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        const persistedAfterIdle = readPersistedChatState(session.id);
        expect(persistedAfterIdle.sdkSessionId).toEqual(expect.any(String));
        const preservedSdkSessionId = persistedAfterIdle.sdkSessionId!;
        const preservedLaneDirective = persistedAfterIdle.lastLaneDirectiveKey;
        expect(preservedLaneDirective).toEqual(expect.any(String));

        // Shutdown re-enters teardownRuntime with runtime already null. Must
        // NOT clobber the preserved sdkSessionId/laneDirectiveKey.
        service.forceDisposeAll();

        const persistedAfterShutdown = readPersistedChatState(session.id);
        expect(persistedAfterShutdown.sdkSessionId).toBe(preservedSdkSessionId);
        expect(persistedAfterShutdown.lastLaneDirectiveKey).toBe(preservedLaneDirective);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears Claude resume metadata when a terminal teardown runs after idle_ttl", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn();
        let streamCall = 0;
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-terminal",
                slash_commands: [],
              };
              yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
              return;
            }
            yield {
              type: "assistant",
              session_id: "sdk-session-terminal",
              message: {
                content: [{ type: "text", text: "Done." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          })()),
          close,
          sessionId: "sdk-session-terminal",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Say hi",
          timeoutMs: 15_000,
        });

        // idle_ttl preserves sdkSessionId/laneDirectiveKey.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        const persistedAfterIdle = readPersistedChatState(session.id);
        expect(persistedAfterIdle.sdkSessionId).toEqual(expect.any(String));
        expect(persistedAfterIdle.lastLaneDirectiveKey).toEqual(expect.any(String));

        // Terminal teardown (user closes the chat) runs teardownRuntime with
        // reason "ended_session" and runtime already null. Must still clear
        // the preserved lane directive so a future resume of a different
        // chat can't reattach to this ended session's lane context.
        // dispose → finishSession → teardownRuntime("ended_session") without
        // deleting the persisted state file.
        await service.dispose({ sessionId: session.id });

        const persistedAfterDispose = readPersistedChatState(session.id);
        expect(persistedAfterDispose.lastLaneDirectiveKey ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});


describe("turn diff capture", () => {
  it("awaits the per-turn fingerprint before emitting a fast completion summary", async () => {
    let releaseBeforeTree!: (tree: Map<string, string>) => void;
    const beforeTree = new Promise<Map<string, string>>((resolve) => {
      releaseBeforeTree = resolve;
    });
    const expectedTree = new Map([["pre-existing.ts", "1:1"]]);
    const collectSummary = vi.fn(async (args: { beforeTree?: Map<string, string> | null }) => (
      args.beforeTree
        ? {
            files: [{ path: "turn.ts", additions: 1, deletions: 0, status: "A" as const }],
            totalAdditions: 1,
            totalDeletions: 0,
          }
        : null
    ));
    turnDiffMockState.beforeTreeGates = [Promise.resolve(new Map()), beforeTree];
    turnDiffMockState.collectSummary = collectSummary;
    vi.mocked(runGit).mockResolvedValue({ stdout: "head-sha\n", stderr: "", exitCode: 0 });

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
      text: "Make a quick change.",
    }, { awaitDispatch: true });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collectSummary).not.toHaveBeenCalled();

    releaseBeforeTree(expectedTree);
    await vi.waitFor(() => {
      expect(collectSummary).toHaveBeenCalledTimes(1);
    });
    expect(collectSummary.mock.calls[0]?.[0].beforeTree).toEqual(expectedTree);
    await vi.waitFor(() => {
      expect(events.some((event) => event.event.type === "turn_diff_summary")).toBe(true);
    });
  });
});
