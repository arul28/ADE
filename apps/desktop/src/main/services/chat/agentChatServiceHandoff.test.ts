import {
  AgentChatCrossMachineHandoffCapsule,
  AgentChatEventEnvelope,
  CODEX_REPLAY_MAX_CHARS,
  EventEmitter,
  claudeInputText,
  claudeNoticeMessages,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  createAgentChatService,
  createHash,
  createService,
  detectAllAuth,
  enforceCrossMachineForkEncodedBudget,
  fs,
  gunzipFromBase64,
  gzipSync,
  installClaudeResponseFixture,
  installRealTranscriptParser,
  makeLaneLinearIssue,
  mockState,
  parseAgentChatTranscript,
  path,
  readPersistedChatState,
  runGit,
  spawn,
  stableStringify,
  streamText,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
  writeTestTranscriptEnvelopes,
  zlib,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";

const HANDOFF_TEST_SHA = "1234567890abcdef1234567890abcdef12345678";

const HANDOFF_BEHIND_SHA = "0123456789abcdef0123456789abcdef01234567";

const HANDOFF_DIVERGED_SHA = "fedcba9876543210fedcba9876543210fedcba98";


function installCleanCrossMachineGitFixture(
  branchRef = "feature/primary",
  porcelain = "",
  originUrl = "git@github.com:example/ade.git",
) {
  vi.mocked(runGit).mockImplementation(async (args) => {
    const command = args.join(" ");
    if (command === "status --porcelain=v1") return { stdout: porcelain, stderr: "", exitCode: 0 };
    if (command === "rev-parse HEAD") return { stdout: `${HANDOFF_TEST_SHA}\n`, stderr: "", exitCode: 0 };
    if (command === "rev-parse @{upstream}") return { stdout: `${HANDOFF_TEST_SHA}\n`, stderr: "", exitCode: 0 };
    if (command === "remote get-url origin") return { stdout: `${originUrl}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "ls-remote") return { stdout: `${HANDOFF_TEST_SHA}\trefs/heads/${branchRef}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "check-ref-format") return { stdout: `${branchRef}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
    if (command === `rev-parse refs/remotes/origin/${branchRef}`) return { stdout: `${HANDOFF_TEST_SHA}\n`, stderr: "", exitCode: 0 };
    if (command === `rev-parse --verify refs/heads/${branchRef}`) return { stdout: "", stderr: "", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}


function installCrossMachineDestinationLaneGitFixture(options: {
  branchRef?: string;
  laneHead?: string;
  remoteHead?: string;
  dirtyPorcelain?: string;
  ancestorExitCode?: number;
  behindBy?: number;
  expectedReachable?: boolean;
  mergeExitCode?: number;
} = {}) {
  const branchRef = options.branchRef ?? "feature/primary";
  const laneHead = options.laneHead ?? HANDOFF_BEHIND_SHA;
  const remoteHead = options.remoteHead ?? HANDOFF_TEST_SHA;
  let merged = false;
  vi.mocked(runGit).mockImplementation(async (args) => {
    const command = args.join(" ");
    if (command === "status --porcelain=v1") {
      return { stdout: options.dirtyPorcelain ?? "", stderr: "", exitCode: 0 };
    }
    if (command === "rev-parse HEAD") {
      return { stdout: `${merged ? HANDOFF_TEST_SHA : laneHead}\n`, stderr: "", exitCode: 0 };
    }
    if (command === `rev-parse refs/remotes/origin/${branchRef}`) {
      return { stdout: `${remoteHead}\n`, stderr: "", exitCode: 0 };
    }
    if (command === `rev-parse --verify refs/heads/${branchRef}`) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (command === `cat-file -e ${HANDOFF_TEST_SHA}^{commit}`) {
      return {
        stdout: "",
        stderr: options.expectedReachable === false ? "missing commit" : "",
        exitCode: options.expectedReachable === false ? 1 : 0,
      };
    }
    if (command === `merge-base --is-ancestor ${laneHead} ${HANDOFF_TEST_SHA}`) {
      return { stdout: "", stderr: "", exitCode: options.ancestorExitCode ?? 0 };
    }
    if (command === `rev-list --count ${laneHead}..${HANDOFF_TEST_SHA}`) {
      return { stdout: `${options.behindBy ?? 3}\n`, stderr: "", exitCode: 0 };
    }
    if (command === `merge --ff-only ${HANDOFF_TEST_SHA}`) {
      const exitCode = options.mergeExitCode ?? 0;
      if (exitCode === 0) merged = true;
      return {
        stdout: exitCode === 0 ? "Fast-forward\n" : "",
        stderr: exitCode === 0 ? "" : "not possible to fast-forward",
        exitCode,
      };
    }
    if (args[0] === "ls-remote") {
      return { stdout: `${HANDOFF_TEST_SHA}\trefs/heads/${branchRef}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "check-ref-format") return { stdout: `${branchRef}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}


function gzipForkContent(content: Buffer | string) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    contentBase64Gzip: zlib.gzipSync(buffer).toString("base64"),
    uncompressedBytes: buffer.length,
  };
}


function makeForkCapsule(overrides: Partial<AgentChatCrossMachineHandoffCapsule> = {}): AgentChatCrossMachineHandoffCapsule {
  const mainContent = Buffer.from('{"type":"session_meta"}\n', "utf8");
  return {
    version: 1,
    handoffId: "handoff-fork-test-1",
    createdAt: "2026-07-10T12:00:00.000Z",
    source: {
      machineName: "Source Mac",
      sessionId: "source-session",
      provider: "claude",
      model: "claude-sonnet-5",
      title: "Fork handoff",
      laneName: "Feature lane",
      branchRef: "feature/handoff-fork",
      headSha: HANDOFF_TEST_SHA,
      originUrl: "https://github.com/example/ade.git",
    },
    target: { targetModelId: "anthropic/claude-sonnet-5" },
    brief: "Fork handoff — full conversation history transported.",
    artifacts: { fileChanges: [], commands: [], errors: [] },
    linearIssues: [],
    continuationPrompt: "This chat was handed off from another ADE machine. Continue the same task from the handoff brief, verify the destination workspace state, and keep working from the next open action.",
    mode: "fork",
    forkTransport: {
      provider: "claude",
      nativeSessionId: "claude-source-session",
      kind: "claude-jsonl",
      mainFile: {
        name: "claude-source-session.jsonl",
        ...gzipForkContent(mainContent),
      },
    },
    ...overrides,
  };
}


function installCliCaptureMock(
  responseForArgs: (args: string[]) => { stdout: string | Buffer; stderr?: string; exitCode?: number },
): void {
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    const proc = new EventEmitter() as any;
    proc.stdin = { end: vi.fn(), write: vi.fn(), writable: true };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    proc.pid = 99_999;
    queueMicrotask(() => {
      const response = responseForArgs(args);
      if (response.stdout) proc.stdout.emit("data", response.stdout);
      if (response.stderr) proc.stderr.emit("data", response.stderr);
      proc.emit("close", response.exitCode ?? 0);
    });
    return proc;
  }) as any);
}


describe("createAgentChatService", () => {
  describe("handoffSession", () => {
    it("rejects handoff while the source chat is still outputting", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      source.status = "active";

      await expect(
        service.handoffSession({
          sourceSessionId: source.id,
          targetModelId: "opencode/openai/gpt-5.4-mini",
        }),
      ).rejects.toThrow("Wait for the current response to finish before handing off this chat.");
    });

    it("clones chat settings and auto-sends the first handoff prompt", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
        sessionProfile: "light",
        reasoningEffort: "high",
        opencodePermissionMode: "full-auto",
      });
      source.executionMode = "parallel";
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "Fix the work-tab handoff UI.",
      });
      const sourceRow = mockState.sessions.get(source.id);
      if (sourceRow) {
        sourceRow.summary = "The bug is narrowed to the work-tab header and OpenAI model registry.";
      }

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
      });

      expect(result.usedFallbackSummary).toBe(true);
      expect(result.session.laneId).toBe(source.laneId);
      expect(result.session.modelId).toBe("opencode/openai/gpt-5.4-mini");
      expect(result.session.sessionProfile).toBe("light");
      expect(result.session.reasoningEffort).toBe("high");
      expect(result.session.opencodePermissionMode).toBe("full-auto");
      expect(result.session.executionMode).toBe("parallel");
      expect(mockState.sessions.get(result.session.id)?.goal).toBe("Fix the work-tab handoff UI.");

      const transcriptPath = mockState.sessions.get(result.session.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      // Wait for the async transcript write to flush (CI runners can be slow)
      await vi.waitFor(() => {
        const transcript = fs.readFileSync(String(transcriptPath), "utf8");
        expect(transcript).toContain("Chat handoff from previous session");
      }, { timeout: 2000, interval: 50 });
    });

    it("brief handoff creates the new chat in the requested target lane", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
        targetLaneId: "lane-2",
      });

      expect(result.session.laneId).toBe("lane-2");
      expect(result.session.provider).toBe("opencode");
      expect(result.session.modelId).toBe("opencode/openai/gpt-5.4-mini");
    });

    it("brief handoff rejects an unknown target lane", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      await expect(service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
        targetLaneId: "lane-nope",
      })).rejects.toThrow("Unknown or unavailable lane");
      expect(source.laneId).toBe("lane-1");
      expect(mockState.sessions.size).toBe(1);
    });

    it("fork handoff rejects a differing target lane", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";

      await expect(service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
        targetLaneId: "lane-2",
      })).rejects.toThrow("keeps the new chat in the source lane");
      expect(source.laneId).toBe("lane-1");
      expect(mockState.sessions.size).toBe(1);
    });

    it("does not seed Codex brief handoffs as provider goals", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "No Machine State Polish",
      });
      const sourceRow = mockState.sessions.get(source.id);
      if (sourceRow) {
        sourceRow.summary = "Fix the iPhone 17 simulator chat layout handoff.";
      }

      const handoffStart = mockState.codexRequestPayloads.length;
      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
      });

      expect(result.session.provider).toBe("codex");

      const handoffPayloads = mockState.codexRequestPayloads.slice(handoffStart);
      const requestMethods = handoffPayloads.map((payload) => String(payload.method ?? ""));
      const turnStartIndex = requestMethods.indexOf("turn/start");
      expect(turnStartIndex).toBeGreaterThanOrEqual(0);
      expect(requestMethods).not.toContain("thread/goal/set");

      const turnStartRequest = handoffPayloads[turnStartIndex] as {
        params?: { input?: Array<{ text?: unknown }> };
      };
      const inputText = turnStartRequest.params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(inputText).toContain("This message was injected automatically by ADE during a chat handoff.");
      expect(inputText).toContain("No Machine State Polish");
      expect(mockState.sessions.get(result.session.id)?.goal ?? null).toBeNull();
    });

    it("appends an optional user note to a brief handoff prompt", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "No Machine State Polish",
      });

      const handoffStart = mockState.codexRequestPayloads.length;
      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        handoffNote: "Focus on the collapsed drawer regression before broader cleanup.",
      });

      expect(result.session.provider).toBe("codex");
      const turnStartRequest = mockState.codexRequestPayloads
        .slice(handoffStart)
        .find((payload) => payload.method === "turn/start") as {
          params?: { input?: Array<{ text?: unknown }> };
        } | undefined;
      const inputText = turnStartRequest?.params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(inputText).toContain("## User handoff note");
      expect(inputText).toContain("Focus on the collapsed drawer regression before broader cleanup.");
    });

    it("forks Codex handoff from the source provider thread without injecting a summary prompt", async () => {
      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-1" },
      }));

      const handoffStart = mockState.codexRequestPayloads.length;
      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("codex");
      expect(result.session.threadId).toBe("forked-thread-1");
      expect(mockState.sessions.get(result.session.id)?.goal ?? null).toBeNull();
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
      const handoffPayloads = mockState.codexRequestPayloads.slice(handoffStart);
      expect(handoffPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "thread/goal/clear",
          params: expect.objectContaining({
            threadId: "source-thread-1",
          }),
        }),
        expect.objectContaining({
          method: "thread/fork",
          params: expect.objectContaining({
            threadId: "source-thread-1",
            excludeTurns: true,
          }),
        }),
        expect.objectContaining({
          method: "thread/goal/clear",
          params: expect.objectContaining({
            threadId: "forked-thread-1",
          }),
        }),
      ]));
      expect(handoffPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("seeds local fork history with handoff provenance", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-history";
      const sourceEnvelope: AgentChatEventEnvelope = {
        sessionId: source.id,
        timestamp: "2026-07-10T11:00:00.000Z",
        event: {
          type: "user_message",
          messageId: "source-message-1",
          text: "Preserve this local fork history.",
        },
        provenance: { messageId: "provider-message-1" },
      };
      writeTestTranscriptEnvelopes(source.id, [sourceEnvelope]);
      mockState.codexResponseOverrides.set("thread/fork", { thread: { id: "forked-thread-history" } });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });

      const targetTranscript = path.join(tmpRoot, ".ade", "transcripts", "chat", `${result.session.id}.jsonl`);
      await vi.waitFor(() => {
        const parsed = fs.readFileSync(targetTranscript, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AgentChatEventEnvelope);
        expect(parsed).toEqual(expect.arrayContaining([
          expect.objectContaining({
            sessionId: result.session.id,
            provenance: expect.objectContaining({
              messageId: "provider-message-1",
              providerOrigin: "handoff_fork",
              sourceSessionId: source.id,
            }),
          }),
        ]));
      });
    });

    // ADE-122 regression: seeding a fork re-published every historical envelope
    // to live event subscribers, streaming the entire source chat over IPC/sync
    // and stalling the app during the handoff. Seeded history must be durable
    // and readable, but never live-published.
    it("seeds forked history into storage without re-publishing it as live events", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-live-publish";
      const sourceEnvelopes: AgentChatEventEnvelope[] = Array.from({ length: 4 }, (_, index) => ({
        sessionId: source.id,
        timestamp: `2026-07-10T11:0${index}:00.000Z`,
        event: index % 2 === 0
          ? { type: "user_message", messageId: `seed-user-${index}`, text: `Seed user message ${index}.` }
          : { type: "text", messageId: `seed-assistant-${index}`, text: `Seed assistant reply ${index}.` },
        provenance: { messageId: `provider-message-${index}` },
      }));
      writeTestTranscriptEnvelopes(source.id, sourceEnvelopes);
      mockState.codexResponseOverrides.set("thread/fork", { thread: { id: "forked-thread-live-publish" } });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });

      const publishedSeeded = events.filter((envelope) =>
        envelope.sessionId === result.session.id
        && (envelope.provenance as { providerOrigin?: string } | undefined)?.providerOrigin === "handoff_fork");
      expect(publishedSeeded).toHaveLength(0);

      const history = await service.getChatEventHistory(result.session.id, { maxEvents: 50 });
      const seededHistory = history.events.filter((envelope) =>
        (envelope.provenance as { providerOrigin?: string } | undefined)?.providerOrigin === "handoff_fork");
      expect(seededHistory).toHaveLength(sourceEnvelopes.length);

      const targetTranscript = path.join(tmpRoot, ".ade", "transcripts", "chat", `${result.session.id}.jsonl`);
      await vi.waitFor(() => {
        const parsed = fs.readFileSync(targetTranscript, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AgentChatEventEnvelope);
        const seededLines = parsed.filter((envelope) =>
          (envelope.provenance as { providerOrigin?: string } | undefined)?.providerOrigin === "handoff_fork");
        expect(seededLines).toHaveLength(sourceEnvelopes.length);
      });
    });

    it("forks an OpenCode chat from the source session without injecting a summary prompt", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "hi",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });
      const promptCountBeforeFork = [...mockState.openCodeSessions.values()]
        .reduce((count, state) => count + state.promptBodies.length, 0);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
        mode: "fork",
      });
      const persisted = readPersistedChatState(result.session.id);
      const promptCountAfterFork = [...mockState.openCodeSessions.values()]
        .reduce((count, state) => count + state.promptBodies.length, 0);

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("opencode");
      expect(mockState.openCodeForkCalls.length).toBeGreaterThanOrEqual(1);
      expect(persisted.providerSessionId).toEqual(expect.stringMatching(/-fork$/));
      expect(promptCountAfterFork).toBe(promptCountBeforeFork);
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
    });

    it("forks a Droid chat and resumes the forked session id", async () => {
      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "hi",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });
      const sourcePooled = mockState.droidPooled;

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "droid/custom:claude-sonnet-5-thinking-32000",
        mode: "fork",
      });
      const persisted = readPersistedChatState(result.session.id);

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("droid");
      expect(sourcePooled.request).toHaveBeenCalledWith("fork_session");
      expect(persisted.droidSdkSessionId).toEqual(expect.stringMatching(/^droid-forked-/));
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
    });

    it("forks a Cursor chat onto a fresh agent replaying the full source transcript", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "Investigate the flaky migration test.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });
      const sourcePersisted = readPersistedChatState(source.id);
      expect(sourcePersisted.cursorSdkAgentId).toBe("cursor-sdk-agent-1");

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "cursor/composer-2",
        mode: "fork",
      });
      const persisted = readPersistedChatState(result.session.id);

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("cursor");
      expect(result.session.id).not.toBe(source.id);
      // Cursor threads cannot be resumed twice: the fork must start agentless.
      expect(persisted.cursorSdkAgentId).toBeUndefined();
      expect(sourcePersisted.recentConversationEntries?.length).toBeGreaterThan(0);
      // The tail is rebuilt by the shared fork path's transcript import, so the
      // Cursor seeding must not copy the entries as well — that doubled it.
      expect(persisted.recentConversationEntries ?? []).toEqual([]);
      // Cursor has no fork API, so the fork carries the whole conversation as a
      // verbatim transcript replay rather than a 20-line tail.
      expect(persisted.pendingTranscriptReplay).toContain("verbatim replay");
      expect(persisted.pendingTranscriptReplay).toContain("Investigate the flaky migration test.");
      expect(result.replayFork).toBeUndefined();
      // No brief was generated — fork carries the conversation, not a summary.
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
    });

    it("forks a Cursor chat onto another provider by replaying the full transcript", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "Keep the banner aligned with the composer.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });
      const persisted = readPersistedChatState(result.session.id);

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("codex");
      expect(persisted.pendingTranscriptReplay).toContain("Keep the banner aligned with the composer.");
      expect(persisted.pendingTranscriptReplay).toContain("verbatim replay");
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
    });

    it("caps a Cursor-to-Codex replay below the app-server input limit", async () => {
      const CODEX_APP_SERVER_INPUT_MAX_CHARS = 1_048_576;
      installRealTranscriptParser();
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [
        {
          sessionId: source.id,
          sequence: 1,
          timestamp: "2026-07-10T11:00:00.000Z",
          event: { type: "user_message", text: `oldest ${"o".repeat(600_000)}` },
        },
        {
          sessionId: source.id,
          sequence: 2,
          timestamp: "2026-07-10T11:01:00.000Z",
          event: { type: "user_message", text: `newest ${"n".repeat(600_000)}` },
        },
      ]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });
      const persisted = readPersistedChatState(result.session.id);

      expect(result.replayFork?.truncated).toBe(true);
      expect(persisted.pendingTranscriptReplay?.length).toBeLessThanOrEqual(CODEX_REPLAY_MAX_CHARS);
      expect(persisted.pendingTranscriptReplay).toContain("newest");
      expect(persisted.pendingTranscriptReplay).not.toContain("oldest");

      await service.sendMessage({
        sessionId: result.session.id,
        text: `Continue from the replay. ${"f".repeat(500_000)}`,
      }, { awaitDispatch: true });
      const turnStart = await vi.waitFor(() => {
        const payload = mockState.codexRequestPayloads
          .slice()
          .reverse()
          .find((candidate) => candidate.method === "turn/start");
        expect(payload).toBeDefined();
        return payload as {
          params?: { input?: Array<{ text?: unknown }> };
        };
      });
      const textInputs = turnStart?.params?.input
        ?.flatMap((entry) => typeof entry.text === "string" ? [entry.text] : []) ?? [];
      const replayInputChars = textInputs.reduce((total, text) => total + text.length, 0);
      expect(replayInputChars).toBeLessThanOrEqual(CODEX_APP_SERVER_INPUT_MAX_CHARS);
      expect(textInputs.join("\n")).toContain("Continue from the replay.");
    });

    it("says how much of the handoff the target model received", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [1, 2, 3].map((sequence) => ({
        sessionId: source.id,
        sequence,
        timestamp: `2026-07-10T11:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `turn ${sequence} ${"t".repeat(950_000)}` },
      })) as AgentChatEventEnvelope[]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      });

      expect(result.replayFork).toMatchObject({
        truncated: true,
        keptTurnCount: 1,
        truncatedTurnCount: 2,
      });
      const notice = events.find((entry) => entry.sessionId === result.session.id
        && entry.event.type === "system_notice"
        && typeof (entry.event as { message?: unknown }).message === "string"
        && (entry.event as { message: string }).message.startsWith("Handoff carried"));
      expect(notice?.event).toMatchObject({ noticeKind: "info" });
      expect((notice?.event as { message: string }).message).toMatch(
        /^Handoff carried the newest 1 of 3 turns, about \d+% of .+'s context\. Older turns are in the original chat\.$/,
      );
    });

    it("retries a too-long handoff replay once with half the transcript", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let resolveRetrySent: () => void = () => {};
      const retrySent = new Promise<void>((resolve) => { resolveRetrySent = resolve; });
      let promptsSeen = 0;
      const send = vi.fn(async (message: unknown) => {
        if (claudeInputText(message).includes("Continue from the replay.")) {
          promptsSeen += 1;
          if (promptsSeen >= 2) resolveRetrySent();
        }
      });
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-replay-overflow", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "prompt_too_long",
            errors: ["prompt is too long for this context window"],
            usage: { input_tokens: 1, output_tokens: 0 },
          };
          await new Promise<void>(() => {});
          return;
        }
        // The retry runs on a fresh provider session, not the one that just
        // rejected the prompt.
        yield { type: "system", subtype: "init", session_id: "sdk-replay-overflow-2", slash_commands: [] };
        await retrySent;
        yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
        await new Promise<void>(() => {});
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-replay-overflow",
        setPermissionMode,
      } as any);

      const onChatHandoffReplay = vi.fn();
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        onChatHandoffReplay,
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [1, 2, 3, 4].map((sequence) => ({
        sessionId: source.id,
        sequence,
        timestamp: `2026-07-10T11:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `turn ${sequence} ${"t".repeat(20_000)}` },
      })) as AgentChatEventEnvelope[]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      });
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay)
        .toContain("verbatim replay");
      onChatHandoffReplay.mockClear();

      const streamCallsBeforeOverflow = stream.mock.calls.length;
      await service.sendMessage({
        sessionId: result.session.id,
        text: "Continue from the replay.",
      }, { awaitDispatch: true });

      const prompts = await vi.waitFor(() => {
        const texts = send.mock.calls
          .map(([message]) => claudeInputText(message))
          .filter((text) => text.includes("Continue from the replay."));
        expect(texts).toHaveLength(2);
        return texts;
      }, { timeout: 5_000 });

      // Half the budget, so the second attempt carries strictly less history.
      expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);
      // Re-sending onto the session that just rejected the prompt would fail
      // the same way; the retry needs a fresh one.
      expect(stream.mock.calls.length).toBeGreaterThan(streamCallsBeforeOverflow);
      // A single-exchange handoff cannot be compacted; asking would have earned
      // "Not enough messages to compact" and a notice that lied.
      expect(send.mock.calls.map(([message]) => claudeInputText(message))).not.toContain("/compact");
      // The retry re-sends the same message; it must not appear twice in the chat.
      expect(events.filter((entry) => entry.sessionId === result.session.id
        && entry.event.type === "user_message"
        && (entry.event as { text?: string }).text === "Continue from the replay.")).toHaveLength(1);
      expect(claudeNoticeMessages(events).some((message) =>
        /^That was too long for .+\. ADE is sending your message again with the newest \d+ turns? of the handoff\.$/.test(message)))
        .toBe(true);
      // One coarse product fact when the retry lands, and only then.
      await vi.waitFor(() => {
        expect(onChatHandoffReplay).toHaveBeenCalledWith({
          sessionId: result.session.id,
          outcome: "retried",
          provider: "claude",
        });
      }, { timeout: 5_000 });
      expect(onChatHandoffReplay).toHaveBeenCalledTimes(1);
    });

    it("repairs a chat already stuck on an oversized replay", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const gate = () => {
        let resolve: () => void = () => {};
        const promise = new Promise<void>((r) => { resolve = r; });
        return { promise, resolve };
      };
      const secondSent = gate();
      const retrySent = gate();
      let secondSends = 0;
      const send = vi.fn(async (message: unknown) => {
        if (!claudeInputText(message).includes("second message")) return;
        secondSends += 1;
        if (secondSends === 1) secondSent.resolve();
        else retrySent.resolve();
      });
      let streamCall = 0;
      let retryServed = false;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-stuck-replay", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          // The first turn swallows the oversized replay and succeeds, so no
          // in-memory replay record survives into the next message.
          yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
          await secondSent.promise;
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "prompt_too_long",
            errors: ["prompt is too long for this context window"],
            usage: { input_tokens: 1, output_tokens: 0 },
          };
          await new Promise<void>(() => {});
          return;
        }
        yield { type: "system", subtype: "init", session_id: "sdk-stuck-replay-2", slash_commands: [] };
        await retrySent.promise;
        if (!retryServed) {
          retryServed = true;
          yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
        }
        await new Promise<void>(() => {});
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-stuck-replay",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [1, 2, 3, 4].map((sequence) => ({
        sessionId: source.id,
        sequence,
        timestamp: `2026-07-10T11:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `turn ${sequence} ${"t".repeat(20_000)}` },
      })) as AgentChatEventEnvelope[]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      });
      // The durable marker is what makes the repair possible one turn later.
      expect(readPersistedChatState(result.session.id).transcriptReplayOrigin)
        .toMatchObject({ sourceSessionId: source.id, keptTurnCount: 4, turnCount: 4 });

      await service.runSessionTurn({ sessionId: result.session.id, text: "first message" });
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay).toBeNull();

      const streamCallsBefore = stream.mock.calls.length;
      await service.runSessionTurn({ sessionId: result.session.id, text: "second message" });

      await vi.waitFor(() => {
        expect(send.mock.calls
          .map(([message]) => claudeInputText(message))
          .filter((text) => text.includes("second message"))).toHaveLength(2);
      }, { timeout: 5_000 });
      // A fresh provider session: resuming the over-full one would overflow again.
      expect(stream.mock.calls.length).toBeGreaterThan(streamCallsBefore);
      // The retry carries the rebuilt replay, read back from the source chat.
      const retryPrompt = send.mock.calls
        .map(([message]) => claudeInputText(message))
        .filter((text) => text.includes("second message"))[1]!;
      expect(retryPrompt).toContain("verbatim replay");
      expect(send.mock.calls.map(([message]) => claudeInputText(message))).not.toContain("/compact");
      expect(claudeNoticeMessages(events).some((message) =>
        /^That was too long for .+\. ADE is sending your message again with the newest \d+ turns? of the handoff\.$/.test(message)))
        .toBe(true);
      // One automatic retry, not a loop.
      expect(send.mock.calls
        .map(([message]) => claudeInputText(message))
        .filter((text) => text.includes("second message"))).toHaveLength(2);
    });

    it("repairs a chat forked before ADE recorded the replay marker", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let resolveRetrySent: () => void = () => {};
      const retrySent = new Promise<void>((resolve) => { resolveRetrySent = resolve; });
      let stuckSends = 0;
      const send = vi.fn(async (message: unknown) => {
        if (!claudeInputText(message).includes("stuck message")) return;
        stuckSends += 1;
        if (stuckSends > 1) resolveRetrySent();
      });
      let streamCall = 0;
      let retryServed = false;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-legacy-stuck", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "prompt_too_long",
            errors: ["prompt is too long for this context window"],
            usage: { input_tokens: 1, output_tokens: 0 },
          };
          await new Promise<void>(() => {});
          return;
        }
        yield { type: "system", subtype: "init", session_id: "sdk-legacy-stuck-2", slash_commands: [] };
        await retrySent;
        if (!retryServed) {
          retryServed = true;
          yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
        }
        await new Promise<void>(() => {});
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-legacy-stuck",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [1, 2, 3].map((sequence) => ({
        sessionId: source.id,
        sequence,
        timestamp: `2026-07-10T11:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `source turn ${sequence}` },
      })) as AgentChatEventEnvelope[]);

      const stuck = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      // The state on disk before this fix existed: forked envelopes carry the
      // source id, but no replay marker was ever written.
      writeTestTranscriptEnvelopes(stuck.id, [1, 2].map((sequence) => ({
        sessionId: stuck.id,
        sequence,
        timestamp: `2026-07-10T12:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `source turn ${sequence}` },
        provenance: { providerOrigin: "handoff_fork", sourceSessionId: source.id },
      })) as AgentChatEventEnvelope[]);
      expect(readPersistedChatState(stuck.id).transcriptReplayOrigin).toBeUndefined();

      await service.runSessionTurn({ sessionId: stuck.id, text: "stuck message" });

      await vi.waitFor(() => {
        expect(send.mock.calls
          .map(([message]) => claudeInputText(message))
          .filter((text) => text.includes("stuck message"))).toHaveLength(2);
      }, { timeout: 5_000 });
      const retryPrompt = send.mock.calls
        .map(([message]) => claudeInputText(message))
        .filter((text) => text.includes("stuck message"))[1]!;
      expect(retryPrompt).toContain("verbatim replay");
      expect(retryPrompt).toContain("source turn 3");
      expect(send.mock.calls.map(([message]) => claudeInputText(message))).not.toContain("/compact");
      expect(readPersistedChatState(stuck.id).transcriptReplayOrigin)
        .toMatchObject({ sourceSessionId: source.id });
    });

    it("leaves a natively forked chat alone when it overflows", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-native-fork", slash_commands: [] };
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
        sessionId: "sdk-native-fork",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      writeTestTranscriptEnvelopes(source.id, [{
        sessionId: source.id,
        sequence: 1,
        timestamp: "2026-07-10T11:01:00.000Z",
        event: { type: "user_message", text: "source turn one" },
      }] as AgentChatEventEnvelope[]);

      const forked = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
      });
      // A Claude → Claude fork is native: the history lives on the provider, so
      // these imported envelopes are a copy, not the thing to re-seed from.
      writeTestTranscriptEnvelopes(forked.id, [{
        sessionId: forked.id,
        sequence: 1,
        timestamp: "2026-07-10T12:01:00.000Z",
        event: { type: "user_message", text: "source turn one" },
        provenance: { providerOrigin: "handoff_fork", sourceSessionId: source.id },
      }] as AgentChatEventEnvelope[]);

      await service.runSessionTurn({ sessionId: forked.id, text: "native message" });

      // The normal overflow handling runs instead: no rebuild, no reset.
      await vi.waitFor(() => {
        expect(send.mock.calls.map(([message]) => claudeInputText(message)).filter((text) => text === "/compact"))
          .toHaveLength(1);
      }, { timeout: 5_000 });
      expect(send.mock.calls
        .map(([message]) => claudeInputText(message))
        .filter((text) => text.includes("native message"))).toHaveLength(1);
      expect(send.mock.calls.map(([message]) => claudeInputText(message))
        .some((text) => text.includes("verbatim replay"))).toBe(false);
      expect(readPersistedChatState(forked.id).transcriptReplayOrigin).toBeUndefined();
    });

    it("reports one coarse outcome when the handoff pre-flight resolves", async () => {
      installRealTranscriptParser();
      const onChatHandoffReplay = vi.fn();
      const { service } = createService({ onChatHandoffReplay });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [{
        sessionId: source.id,
        sequence: 1,
        timestamp: "2026-07-10T11:01:00.000Z",
        event: { type: "user_message", text: "short enough to carry whole" },
      }] as AgentChatEventEnvelope[]);

      const whole = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      });
      expect(onChatHandoffReplay).toHaveBeenCalledTimes(1);
      expect(onChatHandoffReplay).toHaveBeenCalledWith({
        sessionId: whole.session.id,
        outcome: "fit",
        provider: "claude",
      });

      // A transcript the target cannot hold whole reports the truncation, and
      // one it cannot hold at all reports the refusal against the source chat,
      // because no target chat was ever created.
      onChatHandoffReplay.mockClear();
      writeTestTranscriptEnvelopes(source.id, [1, 2].map((sequence) => ({
        sessionId: source.id,
        sequence,
        timestamp: `2026-07-10T12:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `turn ${sequence} ${"t".repeat(950_000)}` },
      })) as AgentChatEventEnvelope[]);
      const partial = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      });
      expect(onChatHandoffReplay).toHaveBeenCalledWith({
        sessionId: partial.session.id,
        outcome: "truncated",
        provider: "claude",
      });

      onChatHandoffReplay.mockClear();
      writeTestTranscriptEnvelopes(source.id, [{
        sessionId: source.id,
        sequence: 1,
        timestamp: "2026-07-10T13:01:00.000Z",
        event: { type: "user_message", text: "x".repeat(2_400_000) },
      }] as AgentChatEventEnvelope[]);
      await expect(service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      })).rejects.toThrow(/too long to hand off/i);
      expect(onChatHandoffReplay).toHaveBeenCalledTimes(1);
      expect(onChatHandoffReplay).toHaveBeenCalledWith({
        sessionId: source.id,
        outcome: "refused",
        provider: "claude",
      });
    });

    it("refuses a handoff whose newest turn cannot fit the target model", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [{
        sessionId: source.id,
        sequence: 1,
        timestamp: "2026-07-10T11:01:00.000Z",
        event: { type: "user_message", text: "x".repeat(2_400_000) },
      }] as AgentChatEventEnvelope[]);

      await expect(service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      })).rejects.toThrow(/too long to hand off/i);
    });

    it("re-enters the turn cleanly when it retries a too-long handoff replay", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let resolveRetrySent: () => void = () => {};
      const retrySent = new Promise<void>((resolve) => { resolveRetrySent = resolve; });
      let prompts = 0;
      const send = vi.fn(async (message: unknown) => {
        if (!claudeInputText(message).includes("look at this")) return;
        prompts += 1;
        if (prompts > 1) resolveRetrySent();
      });
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-retry-reentry", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "prompt_too_long",
            errors: ["prompt is too long for this context window"],
            usage: { input_tokens: 1, output_tokens: 0 },
          };
          await new Promise<void>(() => {});
          return;
        }
        yield { type: "system", subtype: "init", session_id: "sdk-retry-reentry-2", slash_commands: [] };
        // The retry dispatches, then its stream dies — the ordinary way a turn
        // fails for a reason that has nothing to do with the replay.
        await retrySent;
        throw new Error("claude stream died mid-retry");
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-retry-reentry",
        setPermissionMode,
      } as any);

      const onChatHandoffReplay = vi.fn();
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        onChatHandoffReplay,
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [1, 2, 3, 4].map((sequence) => ({
        sessionId: source.id,
        sequence,
        timestamp: `2026-07-10T11:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `turn ${sequence} ${"t".repeat(20_000)}` },
      })) as AgentChatEventEnvelope[]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      });
      onChatHandoffReplay.mockClear();

      const imagePath = path.join(tmpRoot, "retry-attachment.png");
      fs.writeFileSync(imagePath, Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
        "hex",
      ));
      await service.runSessionTurn({
        sessionId: result.session.id,
        text: "look at this",
        attachments: [{ path: imagePath, type: "image" }],
      });

      await vi.waitFor(() => {
        expect(send.mock.calls
          .map(([message]) => claudeInputText(message))
          .filter((text) => text.includes("look at this"))).toHaveLength(2);
      }, { timeout: 5_000 });

      // (a) Re-entering while the first turn is still unwinding must not trip
      // the "turn already active" guard.
      const errorMessages = events.flatMap((entry) => entry.event.type === "error"
        ? [entry.event.message]
        : []);
      expect(errorMessages.some((message) => /turn already active/i.test(message))).toBe(false);

      // (b) The retry carries the same attachments as the message it repeats.
      const attachmentBlocks = send.mock.calls
        .map(([message]) => (message as { message?: { content?: unknown } })?.message?.content)
        .filter((content): content is Array<Record<string, unknown>> => Array.isArray(content))
        .filter((content) => content.some((block) => block?.type === "image"));
      expect(attachmentBlocks).toHaveLength(2);

      // One user message in the transcript: the retry repeats the send, not the bubble.
      expect(events.filter((entry) => entry.sessionId === result.session.id
        && entry.event.type === "user_message"
        && (entry.event as { text?: string }).text === "look at this")).toHaveLength(1);

      // (c) A retry that dies leaves the chat idle, says so, and hands the
      // conversation back so the next message still carries it.
      await vi.waitFor(() => {
        expect(claudeNoticeMessages(events).some((message) =>
          /^The handoff transcript is too long for .+\. ADE kept the newest \d+ turns?\. Send your message again\.$/.test(message)))
          .toBe(true);
      }, { timeout: 5_000 });
      await vi.waitFor(() => {
        expect(readPersistedChatState(result.session.id).pendingTranscriptReplay)
          .toContain("verbatim replay");
      }, { timeout: 5_000 });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(result.session.id))?.status).toBe("idle");
      }, { timeout: 5_000 });
      // One coarse product fact for the give-up, and no "retried" claim.
      expect(onChatHandoffReplay.mock.calls.map(([event]) => event.outcome)).toEqual(["gave_up"]);
    });

    it("treats a Stop during the retry as a stop, not a length failure", async () => {
      installRealTranscriptParser();
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let resolveRetrySent: () => void = () => {};
      const retrySent = new Promise<void>((resolve) => { resolveRetrySent = resolve; });
      let prompts = 0;
      const send = vi.fn(async (message: unknown) => {
        if (!claudeInputText(message).includes("carry on")) return;
        prompts += 1;
        if (prompts > 1) resolveRetrySent();
      });
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-retry-stop", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "prompt_too_long",
            errors: ["prompt is too long for this context window"],
            usage: { input_tokens: 1, output_tokens: 0 },
          };
          await new Promise<void>(() => {});
          return;
        }
        // The retry is dispatched and then simply never answers: the user stops
        // it by hand.
        yield { type: "system", subtype: "init", session_id: "sdk-retry-stop-2", slash_commands: [] };
        await new Promise<void>(() => {});
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-retry-stop",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [1, 2, 3, 4].map((sequence) => ({
        sessionId: source.id,
        sequence,
        timestamp: `2026-07-10T11:0${sequence}:00.000Z`,
        event: { type: "user_message", text: `turn ${sequence} ${"t".repeat(20_000)}` },
      })) as AgentChatEventEnvelope[]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      });

      await service.runSessionTurn({ sessionId: result.session.id, text: "carry on" });
      await retrySent;
      await service.interrupt({ sessionId: result.session.id });

      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(result.session.id))?.status).toBe("idle");
      }, { timeout: 5_000 });

      // A Stop is not a prompt that did not fit. Saying so would be a lie, and
      // re-staging the replay would duplicate what the session already holds.
      expect(claudeNoticeMessages(events).some((message) =>
        /^The handoff transcript is too long for /.test(message))).toBe(false);
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay).toBeNull();
    });

    it("restores the bounded replay when Codex rejects the first turn", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [
        {
          sessionId: source.id,
          sequence: 1,
          timestamp: "2026-07-10T11:00:00.000Z",
          event: { type: "user_message", text: "oldest" },
        },
        {
          sessionId: source.id,
          sequence: 2,
          timestamp: "2026-07-10T11:01:00.000Z",
          event: { type: "user_message", text: "newest" },
        },
      ]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });
      mockState.codexResponseOverrides.set("turn/start", {
        error: { code: -32_000, message: "input rejected" },
      });

      await expect(service.sendMessage({
        sessionId: result.session.id,
        text: "Try this turn.",
      }, { awaitBackendDispatch: true })).rejects.toThrow("input rejected");

      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay)
        .toContain("newest");
    });

    it("blocks an overlapping Codex send before it can race replay restoration", async () => {
      installRealTranscriptParser();
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      writeTestTranscriptEnvelopes(source.id, [
        {
          sessionId: source.id,
          sequence: 1,
          timestamp: "2026-07-10T11:00:00.000Z",
          event: { type: "user_message", text: "oldest" },
        },
        {
          sessionId: source.id,
          sequence: 2,
          timestamp: "2026-07-10T11:01:00.000Z",
          event: { type: "user_message", text: "newest" },
        },
      ]);

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });
      mockState.delayedCodexMethods.add("turn/start");
      mockState.codexResponseOverrides.set("turn/start", {
        error: { code: -32_000, message: "input rejected" },
      });

      const firstSend = service.sendMessage({
        sessionId: result.session.id,
        text: "First turn.",
      }, { awaitBackendDispatch: true });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start"))
          .toHaveLength(1);
      });

      await expect(service.sendMessage({
        sessionId: result.session.id,
        text: "Overlapping turn.",
      }, { awaitBackendDispatch: true })).rejects.toThrow("already active");
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start"))
        .toHaveLength(1);

      mockState.flushCodexResponses();
      await expect(firstSend).rejects.toThrow("input rejected");
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay)
        .toContain("newest");
    });

    it("forks a Claude chat onto a Codex model with a full transcript replay", async () => {
      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "Replay this turn across providers.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });
      const persisted = readPersistedChatState(result.session.id);

      expect(result.session.provider).toBe("codex");
      expect(result.usedFallbackSummary).toBe(false);
      expect(result.replayFork).toBeUndefined();
      expect(persisted.pendingTranscriptReplay).toContain("Replay this turn across providers.");
      expect(persisted.pendingTranscriptReplay).not.toMatch(/This is a brief/i);
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
    });

    it("gives a forked Cursor chat's first send the source conversation as context", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "Investigate the flaky migration test.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "cursor/composer-2",
        mode: "fork",
      });
      mockState.cursorSdkSendCalls = [];
      await service.sendMessage({
        sessionId: result.session.id,
        text: "Keep going.",
      }, { awaitDispatch: true });

      const forkedPrompt = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(forkedPrompt).toContain("Forked Cursor chat");
      expect(forkedPrompt).toContain("verbatim replay");
      expect(forkedPrompt).toContain("Keep going.");
      // Exactly once: the replay and the seeding header must not both carry the
      // conversation, or every line of it shows up twice.
      expect(forkedPrompt.split("Investigate the flaky migration test.").length - 1).toBe(1);
      // The fresh agent is created rather than resumed.
      expect(mockState.cursorSdkAcquireCalls.at(-1)?.agentId).toBeNull();
    });

    it("replays a forked transcript into a Cursor target exactly once, across a restart", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "Replay this Cursor transcript exactly once.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "cursor/composer-2",
        mode: "fork",
      });
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay)
        .toContain("Replay this Cursor transcript exactly once.");

      mockState.cursorSdkSendCalls = [];
      await service.sendMessage({
        sessionId: result.session.id,
        text: "Continue from there.",
      }, { awaitDispatch: true });
      expect(String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? ""))
        .toContain("Replay this Cursor transcript exactly once.");
      // Consumption must be durable, not just in memory.
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay).toBeNull();

      const restarted = createService().service;
      mockState.cursorSdkSendCalls = [];
      await restarted.sendMessage({
        sessionId: result.session.id,
        text: "Keep going.",
      }, { awaitDispatch: true });
      const secondPrompt = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(secondPrompt).not.toContain("verbatim replay");
      expect(secondPrompt).not.toContain("Replay this Cursor transcript exactly once.");
    });

    it("discloses truncation when a forked Cursor transcript exceeds the context window", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      for (let index = 0; index < 6; index += 1) {
        await service.sendMessage({
          sessionId: source.id,
          text: `Turn ${index}: ${"x".repeat(220_000)}`,
        }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(source.status).toBe("idle");
        });
      }

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "cursor/composer-2",
        mode: "fork",
      });

      expect(result.replayFork?.truncated).toBe(true);
      expect(result.replayFork?.truncatedTurnCount).toBeGreaterThan(0);
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay)
        .toContain("verbatim replay");
    });

    it("replays a forked transcript into a Codex target exactly once, across a restart", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.sendMessage({
        sessionId: source.id,
        text: "Replay this transcript exactly once.",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay)
        .toContain("Replay this transcript exactly once.");

      const turnInputSince = async (start: number): Promise<string> => {
        const request = await vi.waitFor(() => {
          const found = mockState.codexRequestPayloads
            .slice(start)
            .find((payload) => payload.method === "turn/start") as {
              params?: { input?: Array<{ text?: unknown }> };
            } | undefined;
          expect(found).toBeTruthy();
          return found!;
        });
        return request.params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      };

      const firstStart = mockState.codexRequestPayloads.length;
      await service.sendMessage({
        sessionId: result.session.id,
        text: "Continue from there.",
      }, { awaitDispatch: true });
      expect(await turnInputSince(firstStart)).toContain("Replay this transcript exactly once.");
      // Consumption must be durable, not just in memory.
      expect(readPersistedChatState(result.session.id).pendingTranscriptReplay).toBeNull();

      const restarted = createService().service;
      const secondStart = mockState.codexRequestPayloads.length;
      await restarted.sendMessage({
        sessionId: result.session.id,
        text: "Keep going.",
      }, { awaitDispatch: true });
      const secondInput = await turnInputSince(secondStart);
      expect(secondInput).not.toContain("verbatim replay");
      expect(secondInput).not.toContain("Replay this transcript exactly once.");
    });

    it("sends only the user note when forking with a handoff note", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-1" },
      }));

      const handoffStart = mockState.codexRequestPayloads.length;
      await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
        handoffNote: "Start by checking the current test failure, then continue.",
      });

      const turnStartRequest = mockState.codexRequestPayloads
        .slice(handoffStart)
        .find((payload) => payload.method === "turn/start") as {
          params?: { input?: Array<{ text?: unknown }> };
        } | undefined;
      const inputText = turnStartRequest?.params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(inputText).toContain("Start by checking the current test failure, then continue.");
      expect(inputText).not.toContain("This message was injected automatically by ADE during a chat handoff.");
    });

    it.each([
      {
        name: "uses rollback on Codex 0.144.5",
        userAgent: "codex/0.144.5 (Mac OS 15.0)",
        targetTurnId: "turn-target",
        expectedMethod: "thread/rollback",
      },
      {
        name: "forks before the target turn on Codex 0.145.0",
        userAgent: "codex/0.145.0-alpha.19",
        targetTurnId: "turn-target",
        expectedMethod: "thread/fork",
      },
      {
        name: "falls back to rollback without a target turn id",
        userAgent: "codex/0.145.0",
        targetTurnId: undefined,
        expectedMethod: "thread/rollback",
      },
      {
        name: "reverts paginated history on Codex 0.149.1",
        userAgent: "codex/0.149.1",
        targetTurnId: "turn-target",
        expectedMethod: "thread/revert",
      },
    ])("$name", async ({ userAgent, targetTurnId, expectedMethod }) => {
      mockState.codexResponseOverrides.set("initialize", { userAgent });
      mockState.codexResponseOverrides.set("thread/rollback", { thread: { id: "rewound-thread" } });
      mockState.codexResponseOverrides.set("thread/fork", { thread: { id: "forked-before-turn" } });
      mockState.codexResponseOverrides.set("thread/revert", { thread: { id: "reverted-thread" } });
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      const rewindEnvelopes: AgentChatEventEnvelope[] = [{
        sessionId: source.id,
        timestamp: "2026-07-07T20:00:00.000Z",
        event: {
          type: "user_message",
          messageId: "user-1",
          text: "rewind this turn",
          ...(targetTurnId ? { turnId: targetTurnId } : {}),
        },
      } as AgentChatEventEnvelope];
      fs.writeFileSync(String(transcriptPath), `${JSON.stringify(rewindEnvelopes[0])}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(rewindEnvelopes);

      await service.rewindFiles({
        sessionId: source.id,
        userMessageId: "user-1",
      });

      const lifecycleRequest = mockState.codexRequestPayloads.find((payload) => payload.method === expectedMethod);
      expect(lifecycleRequest).toBeDefined();
      if (expectedMethod === "thread/fork") {
        expect(lifecycleRequest?.params).toEqual({
          threadId: "source-thread-1",
          beforeTurnId: "turn-target",
        });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/rollback")).toBe(false);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/revert")).toBe(false);
      } else if (expectedMethod === "thread/revert") {
        expect(lifecycleRequest?.params).toEqual({
          threadId: "source-thread-1",
          beforeTurnId: "turn-target",
        });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/rollback")).toBe(false);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/fork")).toBe(false);
      } else {
        expect(lifecycleRequest?.params).toEqual({
          threadId: "source-thread-1",
          numTurns: 1,
        });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/fork")).toBe(false);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/revert")).toBe(false);
      }
    });

    it("explains a removed thread/rollback on a Codex whose version is unknown", async () => {
      mockState.codexResponseOverrides.set("thread/rollback", {
        error: { code: -32601, message: "Method not found" },
      });
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      const envelope = {
        sessionId: source.id,
        timestamp: "2026-09-22T20:00:00.000Z",
        event: { type: "user_message", messageId: "user-1", text: "rewind this turn" },
      } as AgentChatEventEnvelope;
      fs.writeFileSync(String(sessionService.get(source.id)?.transcriptPath), `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);

      await expect(service.rewindFiles({ sessionId: source.id, userMessageId: "user-1" }))
        .rejects.toThrow(/removed turn-count rollback/);
    });

    it("never sends the removed thread/rollback to Codex 0.156 when the turn id is missing", async () => {
      mockState.codexResponseOverrides.set("initialize", { userAgent: "codex/0.156.0" });
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      const envelope = {
        sessionId: source.id,
        timestamp: "2026-09-22T20:00:00.000Z",
        event: { type: "user_message", messageId: "user-1", text: "rewind this turn" },
      } as AgentChatEventEnvelope;
      fs.writeFileSync(String(transcriptPath), `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);

      await expect(service.rewindFiles({ sessionId: source.id, userMessageId: "user-1" }))
        .rejects.toThrow(/removed turn-count rollback/);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/rollback")).toBe(false);
    });

    it("falls back to fork when thread/revert is rejected", async () => {
      mockState.codexResponseOverrides.set("initialize", { userAgent: "codex/0.149.1" });
      mockState.codexResponseOverrides.set("thread/revert", {
        error: { code: -32601, message: "Method not found" },
      });
      mockState.codexResponseOverrides.set("thread/fork", { thread: { id: "forked-after-revert" } });
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      const rewindEnvelopes: AgentChatEventEnvelope[] = [{
        sessionId: source.id,
        timestamp: "2026-07-07T20:00:00.000Z",
        event: {
          type: "user_message",
          messageId: "user-1",
          text: "rewind this turn",
          turnId: "turn-target",
        },
      } as AgentChatEventEnvelope];
      fs.writeFileSync(String(transcriptPath), `${JSON.stringify(rewindEnvelopes[0])}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(rewindEnvelopes);

      await service.rewindFiles({
        sessionId: source.id,
        userMessageId: "user-1",
      });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/revert")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/fork")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/rollback")).toBe(false);
    });

    it("does not delete files during Codex rewind when git cannot prove the path was absent", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      mockState.codexResponseOverrides.set("thread/rollback", () => ({
        thread: { id: "source-thread-1" },
      }));
      const changedFile = path.join(tmpRoot, "src", "safe.ts");
      fs.mkdirSync(path.dirname(changedFile), { recursive: true });
      fs.writeFileSync(changedFile, "keep me", "utf8");
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      const rewindEnvelopes: AgentChatEventEnvelope[] = [
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:00.000Z",
          event: {
            type: "user_message",
            messageId: "user-1",
            text: "change safe file",
            turnId: "turn-1",
          },
        } as AgentChatEventEnvelope,
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:01.000Z",
          event: {
            type: "turn_diff_summary",
            turnId: "turn-1",
            beforeSha: "before-sha",
            afterSha: "after-sha",
            files: [{ path: "src/safe.ts", additions: 1, deletions: 0 }],
            totalAdditions: 1,
            totalDeletions: 0,
          },
        } as AgentChatEventEnvelope,
      ];
      fs.writeFileSync(String(transcriptPath), `${rewindEnvelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(rewindEnvelopes);
      vi.mocked(runGit).mockImplementation(async (args) => {
        if (args[0] === "cat-file") {
          return { stdout: "", stderr: "fatal: transient cat-file failure", exitCode: 128 };
        }
        if (args[0] === "ls-tree") {
          return { stdout: "", stderr: "fatal: transient ls-tree failure", exitCode: 128 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const result = await service.rewindFiles({
        sessionId: source.id,
        userMessageId: "user-1",
      });

      expect(result.canRewind).toBe(true);
      expect(result.conversationRollback).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(fs.existsSync(changedFile)).toBe(true);
      expect(fs.readFileSync(changedFile, "utf8")).toBe("keep me");
      expect(vi.mocked(runGit).mock.calls.some(([args]) => args[0] === "checkout")).toBe(false);
    });

    it("restores Codex rewind files in the personal chat's host cwd, not the lane worktree", async () => {
      // A personal chat whose host named a `requestedCwd` runs in the user's
      // own repository while its lane still points at the synthetic scratch
      // worktree. Re-resolving the directory from the lane id ran
      // `git checkout <sha> -- <path>` somewhere the user never asked about and
      // reported success against it.
      const hostCwd = path.join(tmpRoot, "host-project");
      fs.mkdirSync(hostCwd, { recursive: true });
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
        surface: "personal",
        requestedCwd: hostCwd,
      } as never);
      source.threadId = "source-thread-1";
      source.status = "idle";
      mockState.codexResponseOverrides.set("thread/rollback", () => ({
        thread: { id: "source-thread-1" },
      }));
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      const rewindEnvelopes: AgentChatEventEnvelope[] = [
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:00.000Z",
          event: {
            type: "user_message",
            messageId: "user-1",
            text: "change a file",
            turnId: "turn-1",
          },
        } as AgentChatEventEnvelope,
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:01.000Z",
          event: {
            type: "turn_diff_summary",
            turnId: "turn-1",
            beforeSha: "before-sha",
            afterSha: "after-sha",
            files: [{ path: "src/safe.ts", additions: 1, deletions: 0 }],
            totalAdditions: 1,
            totalDeletions: 0,
          },
        } as AgentChatEventEnvelope,
      ];
      fs.writeFileSync(String(transcriptPath), `${rewindEnvelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(rewindEnvelopes);
      vi.mocked(runGit).mockImplementation(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

      await service.rewindFiles({ sessionId: source.id, userMessageId: "user-1" });

      const checkout = vi.mocked(runGit).mock.calls.find(([args]) => args[0] === "checkout");
      expect(checkout).toBeTruthy();
      expect((checkout?.[1] as { cwd?: string })?.cwd).toBe(hostCwd);
    });

    it("does not recursively delete directories during Codex rewind", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      mockState.codexResponseOverrides.set("thread/rollback", () => ({
        thread: { id: "source-thread-1" },
      }));
      const changedDir = path.join(tmpRoot, "src", "generated");
      const nestedFile = path.join(changedDir, "nested.ts");
      fs.mkdirSync(changedDir, { recursive: true });
      fs.writeFileSync(nestedFile, "keep nested", "utf8");
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      const rewindEnvelopes: AgentChatEventEnvelope[] = [
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:00.000Z",
          event: {
            type: "user_message",
            messageId: "user-1",
            text: "create generated path",
            turnId: "turn-1",
          },
        } as AgentChatEventEnvelope,
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:01.000Z",
          event: {
            type: "turn_diff_summary",
            turnId: "turn-1",
            beforeSha: "before-sha",
            afterSha: "after-sha",
            files: [{ path: "src/generated", additions: 1, deletions: 0 }],
            totalAdditions: 1,
            totalDeletions: 0,
          },
        } as AgentChatEventEnvelope,
      ];
      fs.writeFileSync(String(transcriptPath), `${rewindEnvelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(rewindEnvelopes);
      vi.mocked(runGit).mockImplementation(async (args) => {
        if (args[0] === "cat-file") {
          return { stdout: "", stderr: "fatal: path absent", exitCode: 128 };
        }
        if (args[0] === "ls-tree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const result = await service.rewindFiles({
        sessionId: source.id,
        userMessageId: "user-1",
      });

      expect(result.canRewind).toBe(true);
      expect(result.conversationRollback).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(fs.existsSync(nestedFile)).toBe(true);
      expect(fs.readFileSync(nestedFile, "utf8")).toBe("keep nested");
    });

    it("uses the selected Claude handoff permission instead of the source interaction mode", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-handoff",
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
          message: {
            content: [{ type: "text", text: "Handoff received" }],
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
        sessionId: "sdk-session-handoff",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        interactionMode: "default",
        claudePermissionMode: "default",
        permissionMode: "default",
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        claudePermissionMode: "plan",
        permissionMode: "plan",
      });

      expect(result.session.provider).toBe("claude");
      expect(result.session.interactionMode).toBe("plan");
      expect(result.session.permissionMode).toBe("plan");
      await vi.waitFor(() => {
        expect(setPermissionMode).toHaveBeenCalledWith("plan");
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(expect.stringContaining("This message was injected automatically by ADE during a chat handoff."));
      });
    });

    it("forks Claude handoff from the source SDK session without injecting a summary prompt", async () => {
      const sourceSend = vi.fn().mockResolvedValue(undefined);
      const targetWarmupSend = vi.fn().mockResolvedValue(undefined);
      const forkWarmupSend = vi.fn().mockResolvedValue(undefined);
      const makeWarmHandle = (sdkSessionId: string, send: ReturnType<typeof vi.fn>) => ({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sdkSessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: sdkSessionId,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      });
      const sourceHandle = makeWarmHandle("legacy-source-sdk", sourceSend);
      const targetWarmupHandle = makeWarmHandle("legacy-target-sdk", targetWarmupSend);
      const forkWarmupHandle = makeWarmHandle("legacy-fork-sdk", forkWarmupSend);
      vi.mocked(claudeSdkCreateSessionCompat)
        .mockReturnValueOnce(sourceHandle as any)
        .mockReturnValueOnce(targetWarmupHandle as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(forkWarmupHandle as any);

      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        interactionMode: "default",
        claudePermissionMode: "default",
        permissionMode: "default",
      });

      await vi.waitFor(() => {
        expect(readPersistedChatState(source.id).sdkSessionId).toBeTruthy();
      });
      const sourceSdkSessionId = readPersistedChatState(source.id).sdkSessionId as string;

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
        claudePermissionMode: "plan",
        permissionMode: "plan",
      });

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("claude");
      expect(result.session.interactionMode).toBe("plan");
      expect(result.session.permissionMode).toBe("plan");
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "handoff_summary" }),
      );
      await vi.waitFor(() => {
        expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(
          sourceSdkSessionId,
          expect.objectContaining({
            forkSession: true,
            resume: sourceSdkSessionId,
            sessionId: expect.any(String),
          }),
        );
      });
      expect(readPersistedChatState(result.session.id).sdkSessionId).toBeTruthy();
      expect(readPersistedChatState(result.session.id).forkFromSdkSessionId).toBe(sourceSdkSessionId);
      for (const send of [sourceSend, targetWarmupSend, forkWarmupSend]) {
        expect(send).not.toHaveBeenCalledWith(expect.stringContaining("This message was injected automatically by ADE during a chat handoff."));
      }
    });

    it("does not carry a source interaction mode into non-Claude handoff targets", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      source.interactionMode = "plan";
      source.permissionMode = "plan";

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
        opencodePermissionMode: "full-auto",
        permissionMode: "full-auto",
      });

      expect(result.session.provider).toBe("opencode");
      expect(result.session.interactionMode).toBeUndefined();
      expect(result.session.permissionMode).toBe("full-auto");
      expect(result.session.opencodePermissionMode).toBe("full-auto");
    });

    it("uses AI-generated handoff summaries when a summary model is available", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      vi.mocked(detectAllAuth).mockResolvedValue([
        { type: "api-key", provider: "openai" },
        { type: "cli-subscription", cli: "claude", authenticated: true },
      ] as any);
      const { service, sessionService, aiIntegrationService } = createService();
      vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
        text: [
          "## Current goal",
          "- Continue the same ADE work item.",
          "",
          "## Important decisions and preserved context",
          "- Reuse the previous lane context.",
          "",
          "## Files, commands, and errors to preserve",
          "- src/renderer/components/chat/AgentChatPane.tsx",
          "",
          "## Next action or open issue",
          "- Finish wiring the handoff flow.",
        ].join("\n"),
        structuredOutput: null,
        provider: "codex",
        model: "opencode/openai/gpt-5.4",
        sessionId: null,
        inputTokens: null,
        outputTokens: null,
        durationMs: 1,
      } as any);
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "Finish the handoff flow.",
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
      });

      expect(result.usedFallbackSummary).toBe(false);
      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(expect.objectContaining({
        taskType: "handoff_summary",
      }));
    });
  });

  describe("cross-machine handoff", () => {
    const fakeGitHubToken = ["ghp", "1234567890".repeat(3)].join("_");

    describe("fork mode", () => {
      it("caps gzip inflation before an oversized fork payload is allocated", () => {
        const compressed = zlib.gzipSync(Buffer.alloc(100 * 1024)).toString("base64");
        expect(() => gunzipFromBase64(compressed, 1024)).toThrow();
      });

      it("rejects a fork whose required encoded payload exceeds the transport budget", () => {
        const transport = makeForkCapsule().forkTransport!;
        transport.mainFile.contentBase64Gzip = "A".repeat(11);

        expect(() => enforceCrossMachineForkEncodedBudget(transport, undefined, 10)).toThrow(/too large/);
      });

      it("drops side files when that rescues the fork transport budget", () => {
        const transport = makeForkCapsule().forkTransport!;
        transport.mainFile.contentBase64Gzip = "A".repeat(6);
        transport.sideFiles = [{
          relPath: "sidecar.jsonl",
          contentBase64Gzip: "A".repeat(3),
          uncompressedBytes: 1,
        }];
        const transcriptEnvelopes = {
          contentBase64Gzip: "A".repeat(2),
          uncompressedBytes: 1,
          truncated: false,
        };

        expect(enforceCrossMachineForkEncodedBudget(transport, transcriptEnvelopes, 10)).toBe(true);
        expect(transport.sideFiles).toBeUndefined();
      });

      it("validates fork transport invariants and fingerprints the whole capsule", async () => {
        installCleanCrossMachineGitFixture();
        const { service } = createService();
        const source = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          modelId: "openai/gpt-5.5",
        });
        const transcriptEnvelope: AgentChatEventEnvelope = {
          sessionId: source.id,
          timestamp: "2026-07-10T10:00:00.000Z",
          event: { type: "user_message", messageId: "validator-message", text: "Validate me." },
        };
        const capsule = makeForkCapsule({
          handoffId: "handoff-validator-fork-1",
          source: {
            machineName: "Source Mac",
            sessionId: source.id,
            provider: "codex",
            model: source.model,
            title: null,
            laneName: "Primary",
            branchRef: "feature/primary",
            headSha: HANDOFF_TEST_SHA,
            originUrl: "git@github.com:example/ade.git",
          },
          target: { targetModelId: "openai/gpt-5.5" },
          forkTransport: {
            provider: "codex",
            nativeSessionId: "codex-thread-validator",
            kind: "codex-rollout",
            mainFile: {
              name: "rollout-codex-thread-validator.jsonl",
              ...gzipForkContent('{"type":"session_meta"}\n'),
            },
          },
          transcriptEnvelopes: {
            ...gzipForkContent(`${JSON.stringify(transcriptEnvelope)}\n`),
            truncated: false,
          },
        });
        const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");

        await expect(service.validateCrossMachineSource({
          sourceSessionId: source.id,
          capsule,
          capsuleFingerprint: fingerprint,
        })).resolves.toBeUndefined();
        expect(createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex")).toBe(fingerprint);

        const oversized = structuredClone(capsule);
        oversized.forkTransport!.mainFile.uncompressedBytes = 18 * 1024 * 1024 + 1;
        await expect(service.validateCrossMachineSource({
          sourceSessionId: source.id,
          capsule: oversized,
          capsuleFingerprint: createHash("sha256").update(stableStringify(oversized)).digest("hex"),
        })).rejects.toThrow("fork main file exceeds");

        const missingTransport = structuredClone(capsule);
        delete missingTransport.forkTransport;
        await expect(service.validateCrossMachineSource({
          sourceSessionId: source.id,
          capsule: missingTransport,
          capsuleFingerprint: createHash("sha256").update(stableStringify(missingTransport)).digest("hex"),
        })).rejects.toThrow("missing its fork transport");

        const briefWithTranscript = structuredClone(capsule);
        briefWithTranscript.mode = "brief";
        delete briefWithTranscript.forkTransport;
        await expect(service.validateCrossMachineSource({
          sourceSessionId: source.id,
          capsule: briefWithTranscript,
          capsuleFingerprint: createHash("sha256").update(stableStringify(briefWithTranscript)).digest("hex"),
        })).rejects.toThrow("transcript history without fork mode");
      });

      it("derives Droid autonomy from ADE's own permission chip", async () => {
        // ADE always carries a generic permissionMode, and it maps onto a Droid
        // mode — so ADE does state autonomy here, deliberately. This is the
        // ADE-owned half of the rule: there IS a control for it, so ADE's value
        // wins. The omission path exists for launches that carry no permission
        // mode at all (programmatic/mobile), not for this one.
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "droid",
          model: "claude-opus-4-6",
          modelId: "droid/claude-opus-4-6",
        });
        await service.sendMessage({ sessionId: session.id, text: "hello" });

        await vi.waitFor(() => {
          expect(mockState.droidAcquireCalls.length).toBeGreaterThan(0);
        });
        const settings = mockState.droidAcquireCalls[0]?.settings as Record<string, unknown>;
        expect(settings.autonomyLevel).toBe("low");
        expect(settings.interactionMode).toBe("auto");
        // Never null: an explicit null wedges the Droid RPC for 30 seconds.
        expect(settings.autonomyLevel).not.toBeNull();
        expect(settings.interactionMode).not.toBeNull();
      });

      it("states the Droid autonomy the user picked explicitly", async () => {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "droid",
          model: "claude-opus-4-6",
          modelId: "droid/claude-opus-4-6",
          droidPermissionMode: "auto-high",
        });
        await service.sendMessage({ sessionId: session.id, text: "hello" });

        await vi.waitFor(() => {
          expect(mockState.droidAcquireCalls.length).toBeGreaterThan(0);
        });
        const settings = mockState.droidAcquireCalls[0]?.settings as Record<string, unknown>;
        expect(settings.autonomyLevel).toBe("high");
        expect(settings.interactionMode).toBe("auto");
        expect(settings).not.toHaveProperty("specModeModelId");
      });

      it("maps a Droid plan session onto spec mode with autonomy off", async () => {
        // Plan must stay read-only. Spec dominates Droid's compound autonomyMode,
        // and the spec-mode model fields have to ride along with it — they are
        // gated on the stated interaction mode, so they cannot be emitted for a
        // session that stated none.
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "droid",
          model: "claude-opus-4-6",
          modelId: "droid/claude-opus-4-6",
          interactionMode: "plan",
        });
        await service.sendMessage({ sessionId: session.id, text: "plan this" });

        await vi.waitFor(() => {
          expect(mockState.droidAcquireCalls.length).toBeGreaterThan(0);
        });
        const settings = mockState.droidAcquireCalls[0]?.settings as Record<string, unknown>;
        expect(settings.interactionMode).toBe("spec");
        expect(settings.autonomyLevel).toBe("off");
        expect(settings.specModeModelId).toBeTruthy();
      });

      it("refuses a cross-machine Droid fork with the portability message", async () => {
        installCleanCrossMachineGitFixture();
        const { service } = createService();
        const source = await service.createSession({
          laneId: "lane-1",
          provider: "droid",
          model: "custom:claude-sonnet-5-thinking-32000",
          modelId: "droid/custom:claude-sonnet-5-thinking-32000",
        });

        await expect(service.prepareCrossMachineHandoff({
          sourceSessionId: source.id,
          handoffId: "handoff-droid-fork-1",
          targetModelId: "droid/custom:claude-sonnet-5-thinking-32000",
          mode: "fork",
        })).rejects.toThrow(
          "Droid sessions aren't portable between machines yet. Use a brief handoff instead.",
        );
      });

      it("packages Claude native history and bounded ADE transcript envelopes", async () => {
        installCleanCrossMachineGitFixture();
        installRealTranscriptParser();
        process.env.CLAUDE_CONFIG_DIR = path.join(tmpHomeRoot, "claude-fork-prepare");
        installClaudeResponseFixture({ sdkSessionId: "claude-fork-source", responseText: "ready" });
        const { service } = createService();
        const source = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "claude-sonnet-5",
          modelId: "anthropic/claude-sonnet-5",
        });
        await vi.waitFor(() => expect(readPersistedChatState(source.id).sdkSessionId).toBeTruthy());
        const sourceSdkSessionId = String(readPersistedChatState(source.id).sdkSessionId);
        const providerTranscript = `${JSON.stringify({
          type: "user",
          sessionId: sourceSdkSessionId,
          cwd: tmpRoot,
          message: { role: "user", content: "Carry provider history" },
        })}\n`;
        const providerDir = path.join(
          process.env.CLAUDE_CONFIG_DIR,
          "projects",
          tmpRoot.replace(/[^A-Za-z0-9]/g, "-"),
        );
        fs.mkdirSync(providerDir, { recursive: true });
        fs.writeFileSync(path.join(providerDir, `${sourceSdkSessionId}.jsonl`), providerTranscript, "utf8");
        const sourceEnvelope: AgentChatEventEnvelope = {
          sessionId: source.id,
          timestamp: "2026-07-10T10:00:00.000Z",
          event: { type: "user_message", messageId: "claude-envelope", text: "Carry ADE history" },
        };
        writeTestTranscriptEnvelopes(source.id, [sourceEnvelope]);

        const prepared = await service.prepareCrossMachineHandoff({
          sourceSessionId: source.id,
          handoffId: "handoff-claude-prepare-1",
          targetModelId: "anthropic/claude-sonnet-5",
          mode: "fork",
        });

        expect(prepared.usedFallbackSummary).toBe(false);
        expect(prepared.capsule.mode).toBe("fork");
        expect(prepared.capsule.forkTransport).toMatchObject({
          provider: "claude",
          kind: "claude-jsonl",
          nativeSessionId: sourceSdkSessionId,
        });
        expect(zlib.gunzipSync(Buffer.from(
          prepared.capsule.forkTransport!.mainFile.contentBase64Gzip,
          "base64",
        )).toString("utf8")).toBe(providerTranscript);
        expect(prepared.capsule.transcriptEnvelopes).toBeDefined();
        expect(prepared.capsule.brief).toBe("Fork handoff — full conversation history transported.");
      });

      it("packages an ADE-originated Codex rollout for fork (no external-import originator filter)", async () => {
        installCleanCrossMachineGitFixture();
        process.env.CODEX_HOME = path.join(tmpHomeRoot, "codex-fork-prepare");
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "codex", path: "/usr/local/bin/codex", authenticated: true, verified: true },
        ] as any);
        const { service } = createService();
        const source = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          modelId: "openai/gpt-5.5",
        });
        const threadId = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";
        source.threadId = threadId;
        // Real rollout layout with an ADE originator — the external-import
        // discovery path deliberately filters these out, which used to make
        // fork prepare fail for ADE's own Codex chats.
        const rolloutDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "07", "12");
        fs.mkdirSync(rolloutDir, { recursive: true });
        const rolloutName = `rollout-2026-07-12T00-00-00-${threadId}.jsonl`;
        const rolloutContent = `${JSON.stringify({
          type: "session_meta",
          payload: { id: threadId, originator: "ade_desktop", cwd: tmpRoot },
        })}\n`;
        fs.writeFileSync(path.join(rolloutDir, rolloutName), rolloutContent, "utf8");

        const prepared = await service.prepareCrossMachineHandoff({
          sourceSessionId: source.id,
          handoffId: "handoff-codex-prepare-1",
          targetModelId: "openai/gpt-5.5",
          mode: "fork",
        });

        expect(prepared.capsule.forkTransport).toMatchObject({
          provider: "codex",
          kind: "codex-rollout",
          nativeSessionId: threadId,
        });
        expect(prepared.capsule.forkTransport!.mainFile.name).toBe(rolloutName);
        expect(zlib.gunzipSync(Buffer.from(
          prepared.capsule.forkTransport!.mainFile.contentBase64Gzip,
          "base64",
        )).toString("utf8")).toBe(rolloutContent);
      });

      it("offers brief fallback when a Claude transcript exceeds the fork cap", async () => {
        installCleanCrossMachineGitFixture();
        process.env.CLAUDE_CONFIG_DIR = path.join(tmpHomeRoot, "claude-fork-oversize");
        installClaudeResponseFixture({ sdkSessionId: "claude-fork-oversize", responseText: "ready" });
        const { service } = createService();
        const source = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "claude-sonnet-5",
          modelId: "anthropic/claude-sonnet-5",
        });
        await vi.waitFor(() => expect(readPersistedChatState(source.id).sdkSessionId).toBeTruthy());
        const sourceSdkSessionId = String(readPersistedChatState(source.id).sdkSessionId);
        const providerDir = path.join(
          process.env.CLAUDE_CONFIG_DIR,
          "projects",
          tmpRoot.replace(/[^A-Za-z0-9]/g, "-"),
        );
        fs.mkdirSync(providerDir, { recursive: true });
        fs.writeFileSync(
          path.join(providerDir, `${sourceSdkSessionId}.jsonl`),
          Buffer.alloc(18 * 1024 * 1024 + 1, 0x61),
        );

        await expect(service.prepareCrossMachineHandoff({
          sourceSessionId: source.id,
          handoffId: "handoff-claude-oversize-1",
          targetModelId: "anthropic/claude-sonnet-5",
          mode: "fork",
        })).rejects.toThrow(/too large/);
      });

      it("materializes a Claude fork, seeds provenance, and reuses it idempotently", async () => {
        const branchRef = "feature/handoff-fork";
        installCleanCrossMachineGitFixture(branchRef);
        installRealTranscriptParser();
        process.env.CLAUDE_CONFIG_DIR = path.join(tmpHomeRoot, "claude-fork-accept");
        installClaudeResponseFixture({ sdkSessionId: "destination-warmup", responseText: "ready" });
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
        ] as any);
        const values = new Map<string, unknown>();
        const { service, sessionService, laneService } = createService({
          db: {
            getJson: vi.fn((key: string) => values.get(key) ?? null),
            setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
          },
        });
        const sourceEnvelope: AgentChatEventEnvelope = {
          sessionId: "source-session",
          timestamp: "2026-07-10T10:00:00.000Z",
          event: { type: "user_message", messageId: "accepted-envelope", text: "Seed this history" },
          provenance: { messageId: "native-message" },
        };
        const capsule = makeForkCapsule({
          transcriptEnvelopes: {
            ...gzipForkContent(`${JSON.stringify(sourceEnvelope)}\n`),
            truncated: false,
          },
        });
        const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");

        const first = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
        const destinationLane = await laneService.getSummary(first.laneId);
        const targetProviderDir = path.join(
          process.env.CLAUDE_CONFIG_DIR,
          "projects",
          String(destinationLane.worktreePath).replace(/[^A-Za-z0-9]/g, "-"),
        );
        const providerFilesAfterFirst = fs.readdirSync(targetProviderDir).filter((name) => name.endsWith(".jsonl"));
        const targetTranscript = path.join(tmpRoot, ".ade", "transcripts", "chat", `${first.session.id}.jsonl`);
        await vi.waitFor(() => {
          const envelopes = fs.readFileSync(targetTranscript, "utf8").split(/\r?\n/).filter(Boolean)
            .map((line) => JSON.parse(line) as AgentChatEventEnvelope);
          expect(envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
              sessionId: first.session.id,
              provenance: expect.objectContaining({
                messageId: "native-message",
                providerOrigin: "handoff_fork",
                sourceSessionId: "source-session",
              }),
            }),
          ]));
        });

        const second = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
        expect(second.reusedSession).toBe(true);
        expect(second.session.id).toBe(first.session.id);
        expect(sessionService.create).toHaveBeenCalledTimes(1);
        expect(fs.readdirSync(targetProviderDir).filter((name) => name.endsWith(".jsonl"))).toEqual(providerFilesAfterFirst);
      });

      it("re-materializes a fork when the first accept fails after creating the chat", async () => {
        const branchRef = "feature/handoff-fork-retry";
        installCleanCrossMachineGitFixture(branchRef);
        installRealTranscriptParser();
        process.env.CLAUDE_CONFIG_DIR = path.join(tmpHomeRoot, "claude-fork-retry");
        installClaudeResponseFixture({ sdkSessionId: "destination-warmup", responseText: "ready" });
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
        ] as any);
        const values = new Map<string, unknown>();
        const { service, sessionService, laneService } = createService({
          db: {
            getJson: vi.fn((key: string) => values.get(key) ?? null),
            setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
          },
        });
        const sourceEnvelope: AgentChatEventEnvelope = {
          sessionId: "source-session",
          timestamp: "2026-07-10T10:00:00.000Z",
          event: { type: "user_message", messageId: "retry-envelope", text: "Retry this history" },
        };
        const capsule = makeForkCapsule({
          handoffId: "handoff-claude-retry-1",
          source: {
            machineName: "Source Mac",
            sessionId: "source-session",
            provider: "claude",
            model: "claude-sonnet-5",
            title: "Retry fork",
            laneName: "Retry fork",
            branchRef,
            headSha: HANDOFF_TEST_SHA,
            originUrl: "https://github.com/example/ade.git",
          },
          transcriptEnvelopes: {
            ...gzipForkContent(`${JSON.stringify(sourceEnvelope)}\n`),
            truncated: false,
          },
        });
        const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");
        const realWriteFile = fs.promises.writeFile.bind(fs.promises);
        let materializeAttempts = 0;
        const writeFile = vi.spyOn(fs.promises, "writeFile").mockImplementation((async (filePath, ...args: unknown[]) => {
          if (String(filePath).startsWith(process.env.CLAUDE_CONFIG_DIR!) && String(filePath).endsWith(".jsonl")) {
            materializeAttempts += 1;
            if (materializeAttempts === 1) throw new Error("mock materialize failure");
          }
          return (realWriteFile as (...writeArgs: unknown[]) => Promise<void>)(filePath, ...args);
        }) as typeof fs.promises.writeFile);

        try {
          await expect(service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint }))
            .rejects.toThrow("mock materialize failure");
          expect([...values.values()]).toEqual(expect.arrayContaining([
            expect.objectContaining({ state: "failed", sessionId: expect.any(String) }),
          ]));

          const accepted = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
          const destinationLane = await laneService.getSummary(accepted.laneId);
          const targetProviderDir = path.join(
            process.env.CLAUDE_CONFIG_DIR,
            "projects",
            String(destinationLane.worktreePath).replace(/[^A-Za-z0-9]/g, "-"),
          );
          expect(materializeAttempts).toBe(2);
          expect(fs.readdirSync(targetProviderDir).some((name) => name.endsWith(".jsonl"))).toBe(true);
          await vi.waitFor(() => {
            expect(fs.readFileSync(
              path.join(tmpRoot, ".ade", "transcripts", "chat", `${accepted.session.id}.jsonl`),
              "utf8",
            )).toContain("Retry this history");
          });
          expect(sessionService.create).toHaveBeenCalledTimes(1);
        } finally {
          writeFile.mockRestore();
        }
      });

      it("skips re-materializing and re-importing history when retrying after a post-materialization failure", async () => {
        const branchRef = "feature/handoff-fork-late-retry";
        installCleanCrossMachineGitFixture(branchRef);
        installRealTranscriptParser();
        process.env.CLAUDE_CONFIG_DIR = path.join(tmpHomeRoot, "claude-fork-late-retry");
        installClaudeResponseFixture({ sdkSessionId: "destination-warmup", responseText: "ready" });
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
        ] as any);
        const values = new Map<string, unknown>();
        const { service } = createService({
          db: {
            getJson: vi.fn((key: string) => values.get(key) ?? null),
            setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
          },
        });
        const sourceEnvelope: AgentChatEventEnvelope = {
          sessionId: "source-session",
          timestamp: "2026-07-10T10:00:00.000Z",
          event: { type: "user_message", messageId: "late-retry-envelope", text: "Late retry history" },
        };
        const capsule = makeForkCapsule({
          handoffId: "handoff-claude-late-retry-1",
          source: {
            machineName: "Source Mac",
            sessionId: "source-session",
            provider: "claude",
            model: "claude-sonnet-5",
            title: "Late retry fork",
            laneName: "Late retry fork",
            branchRef,
            headSha: HANDOFF_TEST_SHA,
            originUrl: "https://github.com/example/ade.git",
          },
          transcriptEnvelopes: {
            ...gzipForkContent(`${JSON.stringify(sourceEnvelope)}\n`),
            truncated: false,
          },
        });
        const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");
        const realWriteFile = fs.promises.writeFile.bind(fs.promises);
        let materializeAttempts = 0;
        const writeFile = vi.spyOn(fs.promises, "writeFile").mockImplementation((async (filePath, ...args: unknown[]) => {
          if (String(filePath).startsWith(process.env.CLAUDE_CONFIG_DIR!) && String(filePath).endsWith(".jsonl")) {
            materializeAttempts += 1;
          }
          return (realWriteFile as (...writeArgs: unknown[]) => Promise<void>)(filePath, ...args);
        }) as typeof fs.promises.writeFile);

        try {
          const first = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
          expect(materializeAttempts).toBe(1);

          // Simulate a failure that happened AFTER materialization (e.g. the
          // continuation sendMessage): the durable record keeps the
          // forkMaterializedAt marker but drops back to "failed".
          const recordEntry = [...values.entries()].find(([key, value]) =>
            key.includes("handoff-claude-late-retry-1")
            && Boolean((value as { forkMaterializedAt?: string | null })?.forkMaterializedAt));
          expect(recordEntry, "persisted handoff record with forkMaterializedAt").toBeTruthy();
          values.set(recordEntry![0], {
            ...(recordEntry![1] as Record<string, unknown>),
            state: "failed",
            lastError: "mock post-materialization failure",
          });

          const second = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
          expect(second.session.id).toBe(first.session.id);
          expect(materializeAttempts).toBe(1);
          await vi.waitFor(() => {
            const transcript = fs.readFileSync(
              path.join(tmpRoot, ".ade", "transcripts", "chat", `${first.session.id}.jsonl`),
              "utf8",
            );
            expect(transcript.match(/Late retry history/g)?.length).toBe(1);
          });
        } finally {
          writeFile.mockRestore();
        }
      });

      it("re-materializes into a recreated destination chat even when the fork marker is set", async () => {
        const branchRef = "feature/handoff-fork-recreated";
        installCleanCrossMachineGitFixture(branchRef);
        installRealTranscriptParser();
        process.env.CLAUDE_CONFIG_DIR = path.join(tmpHomeRoot, "claude-fork-recreated");
        installClaudeResponseFixture({ sdkSessionId: "destination-warmup", responseText: "ready" });
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
        ] as any);
        const values = new Map<string, unknown>();
        const { service, sessionService } = createService({
          db: {
            getJson: vi.fn((key: string) => values.get(key) ?? null),
            setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
          },
        });
        const sourceEnvelope: AgentChatEventEnvelope = {
          sessionId: "source-session",
          timestamp: "2026-07-10T10:00:00.000Z",
          event: { type: "user_message", messageId: "recreated-envelope", text: "Recreated history" },
        };
        const capsule = makeForkCapsule({
          handoffId: "handoff-claude-recreated-1",
          source: {
            machineName: "Source Mac",
            sessionId: "source-session",
            provider: "claude",
            model: "claude-sonnet-5",
            title: "Recreated fork",
            laneName: "Recreated fork",
            branchRef,
            headSha: HANDOFF_TEST_SHA,
            originUrl: "https://github.com/example/ade.git",
          },
          transcriptEnvelopes: {
            ...gzipForkContent(`${JSON.stringify(sourceEnvelope)}\n`),
            truncated: false,
          },
        });
        const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");
        const realWriteFile = fs.promises.writeFile.bind(fs.promises);
        let materializeAttempts = 0;
        const writeFile = vi.spyOn(fs.promises, "writeFile").mockImplementation((async (filePath, ...args: unknown[]) => {
          if (String(filePath).startsWith(process.env.CLAUDE_CONFIG_DIR!) && String(filePath).endsWith(".jsonl")) {
            materializeAttempts += 1;
          }
          return (realWriteFile as (...writeArgs: unknown[]) => Promise<void>)(filePath, ...args);
        }) as typeof fs.promises.writeFile);

        try {
          const first = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
          expect(materializeAttempts).toBe(1);

          // Simulate: post-materialization failure recorded AND the destination
          // chat deleted before the retry. The marker alone must not skip
          // seeding a freshly recreated session.
          const recordEntry = [...values.entries()].find(([key, value]) =>
            key.includes("handoff-claude-recreated-1")
            && Boolean((value as { forkMaterializedAt?: string | null })?.forkMaterializedAt));
          expect(recordEntry, "persisted handoff record with forkMaterializedAt").toBeTruthy();
          values.set(recordEntry![0], {
            ...(recordEntry![1] as Record<string, unknown>),
            state: "failed",
            lastError: "mock failure before dispatch",
          });
          mockState.sessions.delete(first.session.id);

          const second = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
          expect(second.session.id).toBe(first.session.id);
          expect(second.reusedSession).toBe(false);
          expect(materializeAttempts).toBe(2);
          expect(sessionService.create).toHaveBeenCalledTimes(2);
        } finally {
          writeFile.mockRestore();
        }
      });

      it("does not clobber a pre-existing Codex rollout and still forks the thread", async () => {
        const branchRef = "feature/handoff-codex-fork";
        installCleanCrossMachineGitFixture(branchRef);
        process.env.CODEX_HOME = path.join(tmpHomeRoot, "codex-fork-accept");
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "codex", path: "/usr/local/bin/codex", authenticated: true, verified: true },
        ] as any);
        mockState.codexResponseOverrides.set("thread/fork", { thread: { id: "forked-thread" } });
        const { service, sessionService } = createService();
        const rollout = '{"type":"session_meta","payload":{"id":"source-codex-thread"}}\n';
        const capsule = makeForkCapsule({
          handoffId: "handoff-codex-accept-1",
          source: {
            machineName: "Source Mac",
            sessionId: "source-session",
            provider: "codex",
            model: "gpt-5.5",
            title: null,
            laneName: "Codex fork",
            branchRef,
            headSha: HANDOFF_TEST_SHA,
            originUrl: "https://github.com/example/ade.git",
          },
          target: { targetModelId: "openai/gpt-5.5" },
          forkTransport: {
            provider: "codex",
            nativeSessionId: "source-codex-thread",
            kind: "codex-rollout",
            mainFile: { name: "rollout-source-codex-thread.jsonl", ...gzipForkContent(rollout) },
          },
        });
        const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");
        const now = new Date();
        const rolloutPath = path.join(
          process.env.CODEX_HOME,
          "sessions",
          String(now.getFullYear()).padStart(4, "0"),
          String(now.getMonth() + 1).padStart(2, "0"),
          String(now.getDate()).padStart(2, "0"),
          "rollout-source-codex-thread.jsonl",
        );
        fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
        fs.writeFileSync(rolloutPath, "existing local rollout", "utf8");

        const accepted = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });

        expect(fs.readFileSync(rolloutPath, "utf8")).toBe("existing local rollout");
        expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
          expect.objectContaining({
            method: "thread/fork",
            params: { threadId: "source-codex-thread", excludeTurns: true },
          }),
        ]));
        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(accepted.session.id, "chat:codex:forked-thread");
      });

      it.each([
        ["plain-text", "Imported session: ses_imported1", "ses_imported1"],
        ["JSON", JSON.stringify({ sessionID: "ses_json1" }), "ses_json1"],
      ])("exports, imports, and forks an OpenCode session with %s import output", async (_shape, importStdout, importedId) => {
        installCleanCrossMachineGitFixture();
        installCliCaptureMock((args) => {
          if (args[0] === "export") return { stdout: JSON.stringify({ id: args[1], messages: [] }) };
          if (args[0] === "import") return { stdout: importStdout };
          return { stdout: "", stderr: "unexpected CLI call", exitCode: 1 };
        });
        vi.mocked(streamText).mockReturnValue({
          fullStream: (async function* () {
            yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
          })(),
        } as any);
        const { service, sessionService } = createService();
        const source = await service.createSession({
          laneId: "lane-1",
          provider: "opencode",
          model: "",
          modelId: "opencode/openai/gpt-5.4",
        });
        await service.sendMessage({ sessionId: source.id, text: "Create provider history" }, { awaitDispatch: true });
        await vi.waitFor(() => expect(source.status).toBe("idle"));

        const prepared = await service.prepareCrossMachineHandoff({
          sourceSessionId: source.id,
          handoffId: "handoff-opencode-fork-1",
          targetModelId: "opencode/openai/gpt-5.4",
          mode: "fork",
        });
        expect(prepared.capsule.forkTransport?.kind).toBe("opencode-export");

        const accepted = await service.acceptCrossMachineHandoff({
          capsule: prepared.capsule,
          capsuleFingerprint: prepared.capsuleFingerprint,
        });
        expect(mockState.openCodeForkCalls).toEqual(expect.arrayContaining([{ id: importedId }]));
        expect(readPersistedChatState(accepted.session.id).providerSessionId).toBe(`${importedId}-fork`);
        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
          accepted.session.id,
          `chat:opencode:${accepted.session.id}`,
        );
      });

      it("reports destination fork capability without changing legacy brief preflight", async () => {
        installCleanCrossMachineGitFixture();
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
        ] as any);
        const { service } = createService();
        const baseArgs = {
          targetModelId: "anthropic/claude-sonnet-5" as const,
          sourceBranchRef: "feature/primary",
          sourceHeadSha: HANDOFF_TEST_SHA,
        };

        await expect(service.preflightCrossMachineDestination({
          ...baseArgs,
          mode: "fork",
          sourceProvider: "claude",
        })).resolves.toMatchObject({ forkHandoffSupport: { supported: true } });
        await expect(service.preflightCrossMachineDestination({
          ...baseArgs,
          mode: "fork",
          sourceProvider: "droid",
        })).resolves.toMatchObject({
          forkHandoffSupport: {
            supported: false,
            reason: "Droid sessions aren't portable between machines yet",
          },
        });
        await expect(service.preflightCrossMachineDestination({
          ...baseArgs,
          mode: "fork",
          sourceProvider: "cursor",
        })).resolves.toMatchObject({
          forkHandoffSupport: { supported: false, reason: "Cursor forks can't move between machines." },
        });
        const brief = await service.preflightCrossMachineDestination(baseArgs);
        expect(brief).not.toHaveProperty("forkHandoffSupport");
      });
    });

    describe("destination lane fast-forward", () => {
      const preflightArgs = {
        targetModelId: "anthropic/claude-sonnet-5" as const,
        sourceBranchRef: "feature/primary",
        sourceHeadSha: HANDOFF_TEST_SHA,
      };

      const authorizeClaude = () => {
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
        ] as any);
      };

      it("offers a fast-forward for an existing clean lane strictly behind the source", async () => {
        installCrossMachineDestinationLaneGitFixture({ behindBy: 3 });
        authorizeClaude();
        const { service } = createService();

        const result = await service.preflightCrossMachineDestination(preflightArgs);

        expect(result.blockingErrors).toEqual([]);
        expect(result.laneFastForward).toEqual({
          laneId: "lane-1",
          laneName: "Primary",
          behindBy: 3,
        });
        expect(result.warnings).toContain(
          "Destination lane 'Primary' is 3 commits behind — ADE can fast-forward it.",
        );
      });

      it.each([
        ["dirty", { dirty: true, rebaseInProgress: false }, "uncommitted changes"],
        ["rebasing", { dirty: false, rebaseInProgress: true }, "rebase in progress"],
      ])("does not offer a fast-forward for a %s destination lane", async (_label, status, message) => {
        installCrossMachineDestinationLaneGitFixture();
        authorizeClaude();
        const { service, laneService } = createService();
        const lane = await laneService.getSummary("lane-1");
        Object.assign(lane.status, status);

        const result = await service.preflightCrossMachineDestination(preflightArgs);

        expect(result).not.toHaveProperty("laneFastForward");
        expect(result.blockingErrors.join(" ")).toContain(message);
        expect(result.blockingErrors).toContain("Destination lane 'Primary' is not at the source commit.");
      });

      it("labels a non-ancestor destination lane as diverged", async () => {
        installCrossMachineDestinationLaneGitFixture({
          laneHead: HANDOFF_DIVERGED_SHA,
          ancestorExitCode: 1,
        });
        authorizeClaude();
        const { service } = createService();

        const result = await service.preflightCrossMachineDestination(preflightArgs);

        expect(result).not.toHaveProperty("laneFastForward");
        expect(result.blockingErrors).toContain(
          "Destination lane 'Primary' has diverged from the source commit.",
        );
      });

      it("refuses to fast-forward a dirty lane", async () => {
        installCrossMachineDestinationLaneGitFixture({ dirtyPorcelain: " M src/dirty.ts\n" });
        const { service } = createService();

        await expect(service.fastForwardCrossMachineHandoffLane({
          laneId: "lane-1",
          expectedHead: HANDOFF_TEST_SHA,
        })).rejects.toThrow("has uncommitted changes and cannot be fast-forwarded");
        expect(vi.mocked(runGit).mock.calls.some(([args]) => args[0] === "merge")).toBe(false);
      });

      it("refuses to fast-forward while a rebase is in progress", async () => {
        installCrossMachineDestinationLaneGitFixture();
        const { service, laneService } = createService();
        const lane = await laneService.getSummary("lane-1");
        lane.status.rebaseInProgress = true;

        await expect(service.fastForwardCrossMachineHandoffLane({
          laneId: "lane-1",
          expectedHead: HANDOFF_TEST_SHA,
        })).rejects.toThrow("while a rebase is in progress");
      });

      it("refuses when the fetched branch has moved away from the expected source commit", async () => {
        installCrossMachineDestinationLaneGitFixture({ remoteHead: HANDOFF_DIVERGED_SHA });
        const { service } = createService();

        await expect(service.fastForwardCrossMachineHandoffLane({
          laneId: "lane-1",
          expectedHead: HANDOFF_TEST_SHA,
        })).rejects.toThrow("no longer points at the expected source commit");
      });

      it("refuses an unreachable expected source commit", async () => {
        installCrossMachineDestinationLaneGitFixture({ expectedReachable: false });
        const { service } = createService();

        await expect(service.fastForwardCrossMachineHandoffLane({
          laneId: "lane-1",
          expectedHead: HANDOFF_TEST_SHA,
        })).rejects.toThrow("cannot reach the expected source commit");
      });

      it("refuses when the lane head is not an ancestor of the expected source commit", async () => {
        installCrossMachineDestinationLaneGitFixture({
          laneHead: HANDOFF_DIVERGED_SHA,
          ancestorExitCode: 1,
        });
        const { service } = createService();

        await expect(service.fastForwardCrossMachineHandoffLane({
          laneId: "lane-1",
          expectedHead: HANDOFF_TEST_SHA,
        })).rejects.toThrow("current commit is not an ancestor");
      });

      it("fast-forwards a clean behind lane with git merge --ff-only", async () => {
        installCrossMachineDestinationLaneGitFixture();
        const { service } = createService();

        await expect(service.fastForwardCrossMachineHandoffLane({
          laneId: "lane-1",
          expectedHead: HANDOFF_TEST_SHA,
        })).resolves.toEqual({ ok: true, head: HANDOFF_TEST_SHA });
        expect(runGit).toHaveBeenCalledWith(
          ["merge", "--ff-only", HANDOFF_TEST_SHA],
          expect.objectContaining({ cwd: tmpRoot, timeoutMs: 60_000 }),
        );
        expect(vi.mocked(runGit).mock.calls.some(([args]) => args.includes("--force"))).toBe(false);
        expect(vi.mocked(runGit).mock.calls.some(([args]) => args[0] === "reset")).toBe(false);
      });
    });

    it("builds a bounded portable capsule only after the source is clean and published", async () => {
      installCleanCrossMachineGitFixture();
      const { service, laneService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      laneService.attachLinearIssueToSession({
        chatSessionId: source.id,
        issues: [makeLaneLinearIssue()],
      });

      const prepared = await service.prepareCrossMachineHandoff({
        sourceSessionId: source.id,
        handoffId: "handoff-source-1",
        targetModelId: "opencode/openai/gpt-5.4-mini",
        continuationPrompt: `Continue with the destination integration test. token=${fakeGitHubToken}`,
      });

      expect(prepared.capsule).toMatchObject({
        version: 1,
        handoffId: "handoff-source-1",
        source: {
          branchRef: "feature/primary",
          headSha: HANDOFF_TEST_SHA,
          originUrl: "git@github.com:example/ade.git",
        },
        continuationPrompt: "Continue with the destination integration test. token=[REDACTED]",
      });
      expect(prepared.capsule.linearIssues).toEqual([
        expect.objectContaining({ identifier: "ADE-123" }),
      ]);
      expect(prepared.capsule.brief.length).toBeLessThanOrEqual(16_000);
      expect(prepared.capsuleFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(prepared.sanitizedSensitiveContext).toBe(true);
      expect(JSON.stringify(prepared.capsule)).not.toContain("threadId");
      expect(JSON.stringify(prepared.capsule)).not.toContain("sdkSessionId");
    });

    it("inherits source settings into the capsule while preserving explicit target overrides", async () => {
      installCleanCrossMachineGitFixture();
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      Object.assign(source, {
        reasoningEffort: "high",
        fastMode: true,
        claudePermissionMode: "bypassPermissions",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "config-toml",
        opencodePermissionMode: "full-auto",
        droidPermissionMode: "agi",
        permissionMode: "full-auto",
        cursorModeId: "plan",
        cursorConfigValues: { privateSetting: "machine-local" },
      });

      const inherited = await service.prepareCrossMachineHandoff({
        sourceSessionId: source.id,
        handoffId: "handoff-settings-inherited-1",
        targetModelId: "opencode/openai/gpt-5.4-mini",
      });
      expect(inherited.capsule.target).toEqual({
        targetModelId: "opencode/openai/gpt-5.4-mini",
        reasoningEffort: "high",
        fastMode: true,
        claudePermissionMode: "bypassPermissions",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "config-toml",
        opencodePermissionMode: "full-auto",
        droidPermissionMode: "agi",
        permissionMode: "full-auto",
        cursorModeId: "plan",
      });

      const overridden = await service.prepareCrossMachineHandoff({
        sourceSessionId: source.id,
        handoffId: "handoff-settings-overridden-1",
        targetModelId: "opencode/openai/gpt-5.4-mini",
        reasoningEffort: null,
        fastMode: false,
        claudePermissionMode: "plan",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        permissionMode: "edit",
        cursorModeId: null,
      });
      expect(overridden.capsule.target).toEqual({
        targetModelId: "opencode/openai/gpt-5.4-mini",
        reasoningEffort: null,
        fastMode: false,
        claudePermissionMode: "plan",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        permissionMode: "edit",
        cursorModeId: null,
      });
      expect(overridden.capsule.target).not.toHaveProperty("cursorConfigValues");
    });

    it("removes credentials from remote URLs, titles, and lane names before transfer", async () => {
      installCleanCrossMachineGitFixture(
        "feature/primary",
        "",
        `https://git-user:${fakeGitHubToken}@github.com/example/ade.git?token=secret-value#credential`,
      );
      const { service, laneService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      await service.updateSession({
        sessionId: source.id,
        title: `Review token=${fakeGitHubToken}`,
        manuallyNamed: true,
      });
      const lane = await laneService.getSummary("lane-1");
      laneService.getSummary.mockResolvedValue({
        ...lane,
        name: "Deploy password=super-secret-value",
      });

      const prepared = await service.prepareCrossMachineHandoff({
        sourceSessionId: source.id,
        handoffId: "handoff-scrubbed-1",
        targetModelId: "opencode/openai/gpt-5.4-mini",
      });

      expect(prepared.capsule.source.originUrl).toBe("https://github.com/example/ade.git");
      expect(prepared.capsule.source.title).toBe("Review token=[REDACTED]");
      expect(prepared.capsule.source.laneName).toBe("Deploy password=[REDACTED]");
      expect(JSON.stringify(prepared.capsule)).not.toMatch(/ghp_|super-secret|secret-value|git-user/i);
      expect(prepared.sanitizedSensitiveContext).toBe(true);
    });

    it("blocks a dirty source lane before generating or transferring context", async () => {
      installCleanCrossMachineGitFixture("feature/primary", " M src/dirty.ts\n");
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      await expect(service.prepareCrossMachineHandoff({
        sourceSessionId: source.id,
        handoffId: "handoff-dirty-1",
        targetModelId: "opencode/openai/gpt-5.4-mini",
      })).rejects.toThrow("Commit or discard every source lane change");
    });

    it("revalidates source cleanliness immediately before destination acceptance", async () => {
      installCleanCrossMachineGitFixture();
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      const prepared = await service.prepareCrossMachineHandoff({
        sourceSessionId: source.id,
        handoffId: "handoff-revalidate-1",
        targetModelId: "opencode/openai/gpt-5.4-mini",
      });
      installCleanCrossMachineGitFixture("feature/primary", " M src/changed-after-review.ts\n");

      await expect(service.validateCrossMachineSource({
        sourceSessionId: source.id,
        capsule: prepared.capsule,
        capsuleFingerprint: prepared.capsuleFingerprint,
      })).rejects.toThrow("Commit or discard every source lane change");
    });

    it("invalidates a capsule when chat activity arrives while the handoff brief is being generated", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
        installCleanCrossMachineGitFixture();
        vi.mocked(detectAllAuth).mockResolvedValue([
          { type: "api-key", provider: "openai" },
          { type: "cli-subscription", cli: "claude", authenticated: true, verified: true },
        ] as any);
        vi.mocked(streamText).mockReturnValue({
          fullStream: (async function* () {
            yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
          })(),
        } as any);
        vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
          raw.split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
            .flatMap((line) => {
              try {
                const parsed = JSON.parse(line) as AgentChatEventEnvelope;
                return parsed?.event ? [parsed] : [];
              } catch {
                return [];
              }
            }),
        );
        const { service, aiIntegrationService } = createService();
        const source = await service.createSession({
          laneId: "lane-1",
          provider: "opencode",
          model: "",
          modelId: "opencode/openai/gpt-5.4",
        });
        vi.mocked(aiIntegrationService.summarizeTerminal).mockImplementationOnce(async () => {
          vi.setSystemTime(new Date("2026-07-10T12:00:01.000Z"));
          await service.runSessionTurn({
            sessionId: source.id,
            text: "This arrived while the handoff brief was being generated.",
          });
          return {
            text: "## Current goal\n- Continue after the source chat changed.",
            structuredOutput: null,
            provider: "codex",
            model: "openai/gpt-5.4-mini",
            sessionId: null,
            inputTokens: null,
            outputTokens: null,
            durationMs: 1,
          } as any;
        });

        const prepared = await service.prepareCrossMachineHandoff({
          sourceSessionId: source.id,
          handoffId: "handoff-mid-prepare-activity-1",
          targetModelId: "opencode/openai/gpt-5.4-mini",
        });

        expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalled();
        expect(prepared.capsule.createdAt).toBe("2026-07-10T12:00:00.000Z");
        await expect(service.validateCrossMachineSource({
          sourceSessionId: source.id,
          capsule: prepared.capsule,
          capsuleFingerprint: prepared.capsuleFingerprint,
        })).rejects.toThrow("source chat changed after the handoff brief was prepared");
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconciles a replay to the same destination lane and chat", async () => {
      const branchRef = "feature/handoff";
      const destinationToken = ["ghp", "destination-token"].join("_");
      installCleanCrossMachineGitFixture(branchRef);
      vi.mocked(detectAllAuth).mockResolvedValue([
        { type: "cli-subscription", cli: "codex", path: "/usr/local/bin/codex", authenticated: true, verified: true },
      ] as any);
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      const values = new Map<string, unknown>();
      const db = {
        getJson: vi.fn((key: string) => values.get(key) ?? null),
        setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
      };
      const { service, laneService, sessionService } = createService({
        db,
        getLocalGitHubToken: () => destinationToken,
      });
      const capsule: AgentChatCrossMachineHandoffCapsule = {
        version: 1,
        handoffId: "handoff-replay-1",
        createdAt: "2026-07-10T12:00:00.000Z",
        source: {
          machineName: "MacBook",
          sessionId: "source-session",
          provider: "opencode",
          model: "opencode/openai/gpt-5.4",
          title: "Cross-machine handoff",
          laneName: "Feature handoff",
          branchRef,
          headSha: HANDOFF_TEST_SHA,
          originUrl: "https://github.com/example/ade.git",
        },
        target: { targetModelId: "opencode/openai/gpt-5.4" },
        brief: "## Current goal\n- Finish the handoff.",
        artifacts: { fileChanges: ["modify src/handoff.ts"], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue from the destination lane.",
      };
      const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");

      const first = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });
      const second = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });

      expect(second.laneId).toBe(first.laneId);
      expect(second.session.id).toBe(first.session.id);
      expect(second.reusedLane).toBe(true);
      expect(second.reusedSession).toBe(true);
      expect(laneService.importBranch).toHaveBeenCalledTimes(1);
      expect(sessionService.create).toHaveBeenCalledTimes(1);
      const expectedAuthorization = `AUTHORIZATION: basic ${Buffer.from(
        `x-access-token:${destinationToken}`,
        "utf8",
      ).toString("base64")}`;
      const remoteAuthCalls = vi.mocked(runGit).mock.calls.filter(([args]) =>
        args[0] === "ls-remote" || args[0] === "fetch",
      );
      // Preflight now fetches before evaluating whether an existing lane is a
      // strict ancestor; acceptance fetches again at its mutation boundary.
      expect(remoteAuthCalls).toHaveLength(3);
      for (const [, options] of remoteAuthCalls) {
        expect(options?.env).toMatchObject({
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: expectedAuthorization,
        });
      }
      expect(Array.from(values.values())).toEqual(expect.arrayContaining([
        expect.objectContaining({
          handoffId: capsule.handoffId,
          state: "complete",
          laneId: first.laneId,
          sessionId: first.session.id,
        }),
      ]));
      expect(JSON.stringify(Array.from(values.values()))).not.toContain(destinationToken);
    });

    it("serializes concurrent destination acceptance for the same handoff", async () => {
      const branchRef = "feature/handoff-concurrent";
      installCleanCrossMachineGitFixture(branchRef);
      vi.mocked(detectAllAuth).mockResolvedValue([
        { type: "cli-subscription", cli: "codex", path: "/usr/local/bin/codex", authenticated: true, verified: true },
      ] as any);
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      const { service, laneService, sessionService } = createService();
      const capsule: AgentChatCrossMachineHandoffCapsule = {
        version: 1,
        handoffId: "handoff-concurrent-1",
        createdAt: "2026-07-10T12:00:00.000Z",
        source: {
          machineName: "MacBook",
          sessionId: "source-session",
          provider: "opencode",
          model: "opencode/openai/gpt-5.4",
          title: "Concurrent handoff",
          laneName: "Concurrent handoff",
          branchRef,
          headSha: HANDOFF_TEST_SHA,
          originUrl: "https://github.com/example/ade.git",
        },
        target: { targetModelId: "opencode/openai/gpt-5.4" },
        brief: "Continue the same task.",
        artifacts: { fileChanges: [], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue.",
      };
      const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");

      const [first, second] = await Promise.all([
        service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint }),
        service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint }),
      ]);

      expect(second.session.id).toBe(first.session.id);
      expect(laneService.importBranch).toHaveBeenCalledTimes(1);
      expect(sessionService.create).toHaveBeenCalledTimes(1);
      expect(streamText).toHaveBeenCalledTimes(1);
    });

    it("does not treat an optimistic user message as a successful dispatch acknowledgement", async () => {
      const branchRef = "feature/handoff-dispatch-retry";
      installCleanCrossMachineGitFixture(branchRef);
      vi.mocked(detectAllAuth).mockResolvedValue([
        { type: "cli-subscription", cli: "droid", path: "/usr/local/bin/droid", authenticated: true, verified: true },
      ] as any);
      mockState.droidPromptError = new Error("provider dispatch rejected");
      const values = new Map<string, unknown>();
      const db = {
        getJson: vi.fn((key: string) => values.get(key) ?? null),
        setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
      };
      const { service } = createService({ db });
      const capsule: AgentChatCrossMachineHandoffCapsule = {
        version: 1,
        handoffId: "handoff-dispatch-retry-1",
        createdAt: "2026-07-10T12:00:00.000Z",
        source: {
          machineName: "MacBook",
          sessionId: "source-session",
          provider: "opencode",
          model: "opencode/openai/gpt-5.4",
          title: null,
          laneName: "Dispatch retry",
          branchRef,
          headSha: HANDOFF_TEST_SHA,
          originUrl: "https://github.com/example/ade.git",
        },
        target: { targetModelId: "droid/custom:claude-sonnet-5-thinking-32000" },
        brief: "Continue the same task.",
        artifacts: { fileChanges: [], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue.",
      };
      const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");

      await expect(service.acceptCrossMachineHandoff({
        capsule,
        capsuleFingerprint: fingerprint,
      })).rejects.toThrow("provider dispatch rejected");
      mockState.droidPromptError = null;
      const accepted = await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });

      expect(accepted.session.id).toBeTruthy();
      expect(mockState.droidPromptCalls).toHaveLength(2);
      expect(Array.from(values.values())).toEqual(expect.arrayContaining([
        expect.objectContaining({ handoffId: capsule.handoffId, state: "complete" }),
      ]));
    });

    it("persists the dispatched checkpoint before publishing the first accepted backend event", async () => {
      const branchRef = "feature/handoff-dispatch-checkpoint";
      installCleanCrossMachineGitFixture(branchRef);
      vi.mocked(detectAllAuth).mockResolvedValue([
        { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
      ] as any);
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-handoff-checkpoint", slash_commands: [] };
            return;
          }
          yield { type: "system", subtype: "init", session_id: "sdk-handoff-checkpoint", slash_commands: [] };
          yield {
            type: "assistant",
            message: {
              id: "assistant-handoff-checkpoint",
              model: "claude-sonnet-5",
              content: [{
                type: "tool_use",
                id: "tool-handoff-checkpoint",
                name: "Read",
                input: { file_path: "README.md" },
              }],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-handoff-checkpoint",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-handoff-checkpoint",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);
      const values = new Map<string, unknown>();
      const db = {
        getJson: vi.fn((key: string) => values.get(key) ?? null),
        setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
      };
      let stateAtFirstBackendEvent: string | null = null;
      const eventTypes: string[] = [];
      const { service } = createService({
        db,
        onEvent: (event: AgentChatEventEnvelope) => {
          eventTypes.push(event.event.type);
          if (event.event.type !== "tool_call" || stateAtFirstBackendEvent !== null) return;
          const record = Array.from(values.values()).find((value) =>
            typeof value === "object" && value !== null && "state" in value,
          ) as { state?: string } | undefined;
          stateAtFirstBackendEvent = record?.state ?? null;
        },
      });
      const capsule: AgentChatCrossMachineHandoffCapsule = {
        version: 1,
        handoffId: "handoff-dispatch-checkpoint-1",
        createdAt: "2026-07-10T12:00:00.000Z",
        source: {
          machineName: "MacBook",
          sessionId: "source-session",
          provider: "opencode",
          model: "opencode/openai/gpt-5.4",
          title: null,
          laneName: "Dispatch checkpoint",
          branchRef,
          headSha: HANDOFF_TEST_SHA,
          originUrl: "https://github.com/example/ade.git",
        },
        target: { targetModelId: "anthropic/claude-sonnet-5" },
        brief: "Continue the same task.",
        artifacts: { fileChanges: [], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue.",
      };
      const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");

      await service.acceptCrossMachineHandoff({ capsule, capsuleFingerprint: fingerprint });

      expect(streamCall).toBeGreaterThan(1);
      await vi.waitFor(() => expect(eventTypes).toContain("tool_call"));
      expect(stateAtFirstBackendEvent).toBe("dispatched");
      expect(Array.from(values.values())).toEqual(expect.arrayContaining([
        expect.objectContaining({ handoffId: capsule.handoffId, state: "complete" }),
      ]));
    });

    it("rejects a Claude handoff when authentication fails before the backend acknowledges the prompt", async () => {
      const branchRef = "feature/handoff-claude-auth";
      installCleanCrossMachineGitFixture(branchRef);
      vi.mocked(detectAllAuth).mockResolvedValue([
        { type: "cli-subscription", cli: "claude", path: "/usr/local/bin/claude", authenticated: true, verified: true },
      ] as any);
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-handoff-auth", slash_commands: [] };
            yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-handoff-auth" };
            return;
          }
          yield { type: "system", subtype: "init", session_id: "sdk-handoff-auth", slash_commands: [] };
          yield {
            type: "assistant",
            error: "authentication_failed",
            message: {
              content: [{ type: "text", text: "Failed to authenticate. API Error: 401" }],
            },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-handoff-auth",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);
      const values = new Map<string, unknown>();
      const db = {
        getJson: vi.fn((key: string) => values.get(key) ?? null),
        setJson: vi.fn((key: string, value: unknown) => values.set(key, structuredClone(value))),
      };
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const capsule: AgentChatCrossMachineHandoffCapsule = {
        version: 1,
        handoffId: "handoff-claude-auth-1",
        createdAt: "2026-07-10T12:00:00.000Z",
        source: {
          machineName: "MacBook",
          sessionId: "source-session",
          provider: "opencode",
          model: "opencode/openai/gpt-5.4",
          title: null,
          laneName: "Claude auth handoff",
          branchRef,
          headSha: HANDOFF_TEST_SHA,
          originUrl: "https://github.com/example/ade.git",
        },
        target: { targetModelId: "anthropic/claude-sonnet-5" },
        brief: "Continue the same task.",
        artifacts: { fileChanges: [], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue.",
      };
      const fingerprint = createHash("sha256").update(stableStringify(capsule), "utf8").digest("hex");

      await expect(service.acceptCrossMachineHandoff({
        capsule,
        capsuleFingerprint: fingerprint,
      })).rejects.toThrow("Claude authentication failed");

      expect(events.some((event) => event.event.type === "user_message")).toBe(true);
      expect(Array.from(values.values())).toEqual(expect.arrayContaining([
        expect.objectContaining({
          handoffId: capsule.handoffId,
          state: "failed",
          lastError: expect.stringMatching(/authentication failed/i),
        }),
      ]));
    });

    it("rejects a handoff capsule whose fingerprint changed in transit", async () => {
      const { service } = createService();
      const capsule = {
        version: 1,
        handoffId: "handoff-tampered-1",
        createdAt: "2026-07-10T12:00:00.000Z",
        source: {
          machineName: "Source Mac",
          sessionId: "source-session",
          provider: "codex",
          model: "gpt-5.5",
          title: null,
          laneName: "Feature lane",
          branchRef: "feature/handoff",
          headSha: HANDOFF_TEST_SHA,
          originUrl: "https://github.com/example/ade.git",
        },
        target: { targetModelId: "openai/gpt-5.5" },
        brief: "Continue the task.",
        artifacts: { fileChanges: [], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue.",
      } as AgentChatCrossMachineHandoffCapsule;

      await expect(service.acceptCrossMachineHandoff({
        capsule,
        capsuleFingerprint: "0".repeat(64),
      })).rejects.toThrow("changed in transit");
    });
  });
});
