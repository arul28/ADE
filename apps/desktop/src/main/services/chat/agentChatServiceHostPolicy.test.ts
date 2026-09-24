import {
  AgentChatEventEnvelope,
  CLAUDE_MUTATING_BUILTIN_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  HOST_TOOL_APPROVAL_NAMES,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  claudeSdkSession,
  codexComputerUseClientCandidates,
  createService,
  mockState,
  os,
  path,
  query,
  startup,
  tmpHomeRoot,
  tmpRoot,
  waitFor,
} from "./agentChatService.testHarness";
import { describe, expect, it, test, vi } from "vitest";


// ---------------------------------------------------------------------------
// Caller MCP isolation (strictMcpConfig)
//
// A user-configured MCP server (filesystem, shell, git, …) is exactly what an
// embedder asking for strict mode wants withheld. Each test pins the MCP
// configuration ADE actually sends when strict mode is on.
// ---------------------------------------------------------------------------

describe("caller MCP isolation", () => {
  // Same overlay, different caller: the ADE SDK injects servers into an
  // ordinary chat. Codex has no "replace the config" mode, so both the caller's
  // servers and strict mode's per-server disables ride the same table.
  it("Codex: merges caller-injected MCP servers into the thread config overlay", async () => {
    const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;
    const { service } = createService({
      resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      resolveCodexConfiguredMcpServerNames: () => ["filesystem"],
    });

    const chat = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      mcpServers: {
        embedderHttp: { type: "http", url: "https://example.test/mcp", headers: { "x-key": "v" } },
        embedderStdio: { type: "stdio", command: "node", args: ["server.js"] },
      },
    });
    await service.sendMessage({ sessionId: chat.id, text: "Do the work." });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((p) => p.method === "thread/start")).toBe(true);
    });

    const start = mockState.codexRequestPayloads.find((p) => p.method === "thread/start") as any;
    // Without strict mode, `filesystem` is untouched: the user's own Codex
    // config keeps loading exactly as it did before this feature.
    expect(start?.params?.config?.mcp_servers).toEqual({
      computer_use: { command: signedClient, args: ["mcp"], enabled: true },
      embedderHttp: { url: "https://example.test/mcp", http_headers: { "x-key": "v" }, enabled: true },
      embedderStdio: { command: "node", args: ["server.js"], enabled: true },
    });
  });

  it("Codex: strict mode disables the user's configured servers but not the caller's", async () => {
    const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;
    const { service } = createService({
      resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      resolveCodexConfiguredMcpServerNames: () => ["filesystem", "embedder"],
    });

    const chat = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
      strictMcpConfig: true,
    });
    await service.sendMessage({ sessionId: chat.id, text: "Do the work." });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((p) => p.method === "thread/start")).toBe(true);
    });

    const start = mockState.codexRequestPayloads.find((p) => p.method === "thread/start") as any;
    // `embedder` is in BOTH lists — the user configured a server by that name
    // and the caller injected one. The caller's definition has to win, or
    // strict mode would disable the very server it was asked to add.
    expect(start?.params?.config?.mcp_servers).toEqual({
      computer_use: { command: signedClient, args: ["mcp"], enabled: true },
      filesystem: { enabled: false },
      embedder: { url: "https://example.test/mcp", enabled: true },
    });
  });

  // `computer_use` is BOTH an ADE-managed server and a name that appears in the
  // user's config.toml mcp_servers table. That made it the one name where merge
  // order mattered, and the order was wrong: strict mode disabled ADE's own
  // Computer Use, because the strict overrides were spread after it.
  it("Codex: ADE's computer_use survives strict mode and a colliding caller name", async () => {
    const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;
    const { service } = createService({
      resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      // The user's config.toml declares computer_use, so strict mode would
      // otherwise emit `computer_use: { enabled: false }`.
      resolveCodexConfiguredMcpServerNames: () => ["filesystem", "computer_use"],
    });

    const chat = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      mcpServers: { embedder: { type: "http", url: "https://example.test/mcp" } },
      strictMcpConfig: true,
    });
    await service.sendMessage({ sessionId: chat.id, text: "Do the work." });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((p) => p.method === "thread/start")).toBe(true);
    });

    const start = mockState.codexRequestPayloads.find((p) => p.method === "thread/start") as any;
    const servers = start?.params?.config?.mcp_servers;
    // ADE's own server wins over both the strict override and any caller entry.
    expect(servers.computer_use).toEqual({ command: signedClient, args: ["mcp"], enabled: true });
    // The user's other servers are still disabled — strict mode still works.
    expect(servers.filesystem).toEqual({ enabled: false });
    expect(servers.embedder).toMatchObject({ enabled: true });
  });

});


// ---------------------------------------------------------------------------
// Host sleep
//
// The incident: a MacBook slept mid-turn, the in-flight API call died, and the
// transcript reported `Claude API retry 1/10: unknown` — while ADE already knew
// the machine was suspending. These cover the three things that must now hold:
// one chip per sleep that resolves itself, retries held rather than burned, and
// a genuine API failure left completely alone.
// ---------------------------------------------------------------------------
describe("host sleep narration", () => {
  /** A power source the test drives by hand, standing in for Electron's. */
  function fakeHostPowerSource() {
    const listeners = new Set<(event: any) => void>();
    let sleepState: "awake" | "asleep" = "awake";
    // Stamped from the same clock the tracker reads, exactly as a real monitor
    // does: `asleep` is age-bounded against this, and a stamp frozen at a fake
    // epoch would read as a stuck, long-stale announcement.
    let sleepStateAt = Date.now();
    return {
      source: {
        getPower: () => null,
        getSleepState: () => sleepState,
        getSleepStateAt: () => sleepStateAt,
        getSuspendGapMs: () => null,
        subscribe: (listener: (event: any) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      } as any,
      suspend(at = 1_000, stateAt = Date.now()) {
        sleepState = "asleep";
        sleepStateAt = stateAt;
        for (const listener of [...listeners]) listener({ kind: "suspend", at, announced: true });
      },
      resume(at = 241_000, gapMs: number | null = 240_000, stateAt = Date.now()) {
        sleepState = "awake";
        sleepStateAt = stateAt;
        for (const listener of [...listeners]) listener({ kind: "resume", at, gapMs, announced: true });
      },
    };
  }

  /**
   * A Claude stream that parks mid-turn so the test can suspend the host at a
   * moment when a turn is genuinely in flight, then parks again so it can wake
   * it before the turn finishes.
   */
  function installParkedClaudeStream(retry: Record<string, unknown>) {
    let releaseBeforeRetry = (): void => {};
    let releaseBeforeResult = (): void => {};
    const beforeRetry = new Promise<void>((resolve) => {
      releaseBeforeRetry = resolve;
    });
    const beforeResult = new Promise<void>((resolve) => {
      releaseBeforeResult = resolve;
    });
    const reached = { retry: false, result: false };

    const send = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        return;
      }
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Running tests…" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      await beforeRetry;
      yield { type: "system", subtype: "api_retry", session_id: "sdk-session-sleep", ...retry };
      reached.retry = true;
      await beforeResult;
      reached.result = true;
      yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close,
      sessionId: "sdk-session-sleep",
    } as any);
    vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
      send,
      stream,
      close,
      sessionId: "sdk-session-sleep",
    } as any);

    return { releaseBeforeRetry, releaseBeforeResult, reached };
  }

  const noticesOf = (onEvent: ReturnType<typeof vi.fn>) => onEvent.mock.calls
    .map((call) => call[0])
    .filter((envelope: any) => envelope?.event?.type === "system_notice")
    .map((envelope: any) => envelope.event);

  const turnStarted = (onEvent: ReturnType<typeof vi.fn>) => onEvent.mock.calls
    .some((call) => {
      const event = (call[0] as any)?.event;
      return event?.type === "status" && event.turnStatus === "started";
    });

  it("shows one chip that resolves in place, and holds the retry the sleep caused", async () => {
    const power = fakeHostPowerSource();
    const parked = installParkedClaudeStream({
      error: "unknown",
      attempt: 1,
      max_retries: 10,
    });

    const onEvent = vi.fn();
    const { service, logger } = createService({ onEvent, hostPowerSource: power.source });
    try {
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "run the tests",
        timeoutMs: 15_000,
      });
      await waitFor(() => turnStarted(onEvent));

      power.suspend();
      const paused = noticesOf(onEvent).filter((event: any) => event.status === "host_asleep");
      expect(paused).toHaveLength(1);
      expect(paused[0].message).toBe("Paused — computer asleep");

      // Let the suspend-caused retry arrive while the machine is down.
      parked.releaseBeforeRetry();
      await waitFor(() => parked.reached.retry);

      expect(noticesOf(onEvent).filter((event: any) =>
        typeof event.message === "string" && event.message.startsWith("Claude API retry"),
      )).toHaveLength(0);
      expect(onEvent.mock.calls.filter((call) => (call[0] as any)?.event?.type === "api_retry"))
        .toHaveLength(0);
      // The retry really did arrive and really was held — without this the
      // two assertions above would also pass on a stream that never retried.
      expect(logger.info).toHaveBeenCalledWith(
        "agent_chat.api_retry_held_for_host_suspend",
        expect.objectContaining({ providerCause: "unknown", sleepState: "asleep" }),
      );
      // Still ONE chip — the held retry must not add a second artifact.
      expect(noticesOf(onEvent).filter((event: any) => event.status === "host_asleep")).toHaveLength(1);

      power.resume();
      parked.releaseBeforeResult();
      await turn;

      const asleep = noticesOf(onEvent).filter((event: any) => event.status === "host_asleep");
      const awake = noticesOf(onEvent).filter((event: any) => event.status === "host_awake");
      expect(asleep).toHaveLength(1);
      expect(awake).toHaveLength(1);
      expect(awake[0].message).toBe("Resumed · paused 4m");
      // Same identity is what folds the two halves onto one transcript row.
      expect(awake[0].detail.hostSleep.sleepId).toBe(asleep[0].detail.hostSleep.sleepId);
      // And the turn itself still finished after the wake.
      expect(onEvent.mock.calls.some((call) => (call[0] as any)?.event?.type === "done")).toBe(true);
    } finally {
      await service.disposeAll();
    }
  });

  it("leaves a genuine API failure retrying and reporting its real cause", async () => {
    const power = fakeHostPowerSource();
    const parked = installParkedClaudeStream({
      error: "overloaded",
      error_status: 529,
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 2_000,
    });

    const onEvent = vi.fn();
    const { service } = createService({ onEvent, hostPowerSource: power.source });
    try {
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "run the tests",
        timeoutMs: 15_000,
      });
      await waitFor(() => turnStarted(onEvent));

      // Even with the host asleep, an error the API itself named is the truth.
      power.suspend();
      parked.releaseBeforeRetry();
      await waitFor(() => parked.reached.retry);
      parked.releaseBeforeResult();
      await turn;

      expect(onEvent.mock.calls.some((call) => {
        const event = (call[0] as any)?.event;
        return event?.type === "activity"
          && event.activity === "working"
          && event.detail === "Retrying Claude · attempt 1 of 10 · retrying in 2s";
      })).toBe(true);
      expect(onEvent.mock.calls.filter((call) => (call[0] as any)?.event?.type === "api_retry"))
        .toHaveLength(1);
    } finally {
      await service.disposeAll();
    }
  });

  it("leaves an idle chat alone when the machine sleeps", async () => {
    const power = fakeHostPowerSource();
    const onEvent = vi.fn();
    const { service } = createService({ onEvent, hostPowerSource: power.source });
    try {
      await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      power.suspend();
      power.resume();
      expect(noticesOf(onEvent).filter((event: any) =>
        event.status === "host_asleep" || event.status === "host_awake",
      )).toHaveLength(0);
    } finally {
      await service.disposeAll();
    }
  });
});


describe("host permission policy", () => {
  const openPersonalClaudeSession = async (
    permissionPolicy: Record<string, unknown> | undefined,
    sdkSessionId: string,
  ) => {
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(claudeSdkSession(sdkSessionId) as any);
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "sonnet",
      sessionProfile: "light",
      surface: "personal",
      ...(permissionPolicy ? { permissionPolicy } : {}),
    } as any);
    await vi.waitFor(() => {
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
    });
    const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
      allowedTools?: string[];
      disallowedTools?: string[];
      managedSettings?: {
        allowedMcpServers?: Array<{ serverName: string }>;
        allowManagedMcpServersOnly?: boolean;
      };
      canUseTool?: (
        tool: string,
        input: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    return { service, session, opts, events };
  };

  const callTool = (
    opts: { canUseTool?: Function },
    tool: string,
    input: Record<string, unknown>,
    toolUseID: string,
  ) => (opts.canUseTool as Function)(tool, input, {
    signal: new AbortController().signal,
    toolUseID,
  }) as Promise<Record<string, unknown>>;

  it("installs no tool gate on a personal chat that supplied no policy", async () => {
    // The whole point of gating this on the policy: every SDK chat that exists
    // today keeps running with no gate, so none of them starts parking turns
    // on a host that renders no approval card.
    const { opts } = await openPersonalClaudeSession(undefined, "sdk-policy-absent");
    expect(opts.canUseTool).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.disallowedTools).toBeUndefined();
  });

  it("translates the policy into Claude's tool lists and wires the gate", async () => {
    const { opts } = await openPersonalClaudeSession({
      allowedTools: ["mcp:srv:*", "Read"],
      deniedTools: ["Bash"],
      fallback: "ask",
    }, "sdk-policy-lists");
    expect(opts.allowedTools).toEqual(["mcp__srv", "Read"]);
    expect(opts.disallowedTools).toEqual(["Bash"]);
    expect(typeof opts.canUseTool).toBe("function");
  });

  it("enforces a deny fallback in the tool lists, not through the prompt", async () => {
    // The Agent SDK applies these lists itself: a disallowed tool leaves the
    // model's catalog. `canUseTool` did not fire on the SDK version measured,
    // so a policy that only wired the prompt would enforce nothing.
    const { opts } = await openPersonalClaudeSession({
      allowedTools: ["mcp:srv:*"],
      fallback: "deny",
    }, "sdk-policy-deny-enforced");

    // The roster comes from the implementation. Restating it here meant a tool
    // added to the deny set had to be remembered in three files.
    for (const tool of CLAUDE_MUTATING_BUILTIN_TOOLS) {
      expect(opts.disallowedTools).toContain(tool);
    }
    // A deny fallback stops the agent changing things; it does not blind it.
    expect(opts.disallowedTools).not.toContain("Read");
    expect(opts.disallowedTools).not.toContain("Grep");
    // Still wired as a second line, in case a future SDK does call back.
    expect(typeof opts.canUseTool).toBe("function");
  });

  it("scopes MCP to the servers the policy names under a deny fallback", async () => {
    const { opts } = await openPersonalClaudeSession({
      allowedTools: ["mcp:srv:*"],
      fallback: "deny",
    }, "sdk-policy-deny-mcp-scope");

    expect(opts.managedSettings?.allowedMcpServers).toEqual([{ serverName: "srv" }]);
    expect(opts.managedSettings?.allowManagedMcpServersOnly).toBe(true);
  });

  it("reads autoApproveMcpServers into the same allowlist", async () => {
    const { opts } = await openPersonalClaudeSession({
      autoApproveMcpServers: ["srv", "other"],
      fallback: "deny",
    }, "sdk-policy-deny-mcp-auto");

    expect(opts.managedSettings?.allowedMcpServers)
      .toEqual([{ serverName: "srv" }, { serverName: "other" }]);
  });

  it("leaves the catalog and MCP alone under an ask fallback", async () => {
    // "ask" still routes through the prompt path, so removing tools up front
    // would refuse the very work the host asked to be consulted about.
    const { opts } = await openPersonalClaudeSession({
      allowedTools: ["mcp:srv:*"],
      fallback: "ask",
    }, "sdk-policy-ask-no-additions");

    expect(opts.disallowedTools).toBeUndefined();
    expect(opts.managedSettings?.allowManagedMcpServersOnly).toBeUndefined();
    expect(typeof opts.canUseTool).toBe("function");
  });

  it("names caller MCP servers a deny policy blocks, end to end", async () => {
    // The report is the only place a host learns that a server it supplied in
    // the same create call is unreachable. Both fields are set together and it
    // is easy to set one and forget the other.
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(
      claudeSdkSession("sdk-policy-blocked-caller") as any,
    );
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "sonnet",
      sessionProfile: "light",
      surface: "personal",
      mcpServers: {
        srv: { type: "http", url: "https://example.test/srv" },
        other: { type: "http", url: "https://example.test/other" },
      },
      permissionPolicy: { allowedTools: ["mcp:srv:*"], fallback: "deny" },
    } as never);

    const summary = await service.getSessionSummary(session.id);
    expect(summary?.permissionCapability?.level).toBe("enforced");
    expect(summary?.permissionCapability?.residual)
      .toContain("caller MCP servers blocked by the policy: other");
  });

  it("downgrades to best-effort when the policy names one MCP tool", async () => {
    const { service, session, opts } = await openPersonalClaudeSession({
      allowedTools: ["mcp:srv:search"],
      fallback: "deny",
    }, "sdk-policy-tool-level-mcp");

    // The server is still admitted — that is exactly the hole being reported.
    expect(opts.managedSettings?.allowedMcpServers).toEqual([{ serverName: "srv" }]);
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.permissionCapability?.level).toBe("best-effort");
    expect(summary?.permissionCapability?.residual)
      .toContain("individual MCP tool entries admit the whole server");
  });

  it("reports the capability level per fallback", async () => {
    const deny = await openPersonalClaudeSession({ fallback: "deny" }, "sdk-policy-cap-deny");
    await expect(deny.service.getSessionSummary(deny.session.id)).resolves.toMatchObject({
      permissionCapability: { level: "enforced" },
    });

    const ask = await openPersonalClaudeSession({ fallback: "ask" }, "sdk-policy-cap-ask");
    const askSummary = await ask.service.getSessionSummary(ask.session.id);
    expect(askSummary?.permissionCapability?.level).toBe("best-effort");
    expect(askSummary?.permissionCapability?.residual).toContain("permissions.defaultMode: auto");
  });

  it("allows a tool the policy names", async () => {
    const { opts } = await openPersonalClaudeSession({
      allowedTools: ["Bash"],
      fallback: "deny",
    }, "sdk-policy-allow");
    await expect(callTool(opts, "Bash", { command: "ls" }, "tool-allow-1"))
      .resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("denies a tool the policy refuses, with the policy's own message", async () => {
    const { opts, events } = await openPersonalClaudeSession({
      deniedTools: ["Bash"],
      fallback: "ask",
    }, "sdk-policy-deny");
    await expect(callTool(opts, "Bash", { command: "rm -rf /" }, "tool-deny-1"))
      .resolves.toEqual({
        behavior: "deny",
        message: "Denied by the host permission policy.",
      });
    expect(events.some((event) => event.event.type === "approval_request")).toBe(false);
  });

  it("asks, and the answer releases the tool call", async () => {
    const { service, session, opts, events } = await openPersonalClaudeSession({
      fallback: "ask",
    }, "sdk-policy-ask");
    const pending = callTool(opts, "Bash", { command: "ls" }, "tool-ask-1");

    await vi.waitFor(() => {
      expect(events.some((event) => event.event.type === "approval_request")).toBe(true);
    });
    const request = events.find((event) => event.event.type === "approval_request")?.event as
      { itemId: string; kind: string };
    expect(request.kind).toBe("command");

    // The same request a reloaded host would ask for to redraw its card.
    expect(service.listPendingInputs({ sessionId: session.id }).requests.map((r) => r.itemId))
      .toContain(request.itemId);

    await service.approveToolUse({
      sessionId: session.id,
      itemId: request.itemId,
      decision: "accept",
    });
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
    expect(service.listPendingInputs({ sessionId: session.id }).requests).toEqual([]);
  });

  it("does not prompt for Claude's read-only built-ins under fallback ask", async () => {
    // A card for every file read teaches a user to click Allow without
    // reading it, which costs more than the cards buy. The check is literal
    // set membership, so this is not the old substring heuristic returning.
    const { opts, events } = await openPersonalClaudeSession({
      fallback: "ask",
    }, "sdk-policy-read-only");
    // Every member of the implementation's own set, so a tool added to it is
    // covered here without a second edit.
    for (const tool of CLAUDE_READ_ONLY_TOOLS) {
      await expect(callTool(opts, tool, { file_path: "README.md" }, `tool-ro-${tool}`))
        .resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "README.md" } });
    }
    expect(events.some((event) => event.event.type === "approval_request")).toBe(false);
  });

  it("prompts for a mutating built-in under fallback ask", async () => {
    const { opts, events } = await openPersonalClaudeSession({
      fallback: "ask",
    }, "sdk-policy-mutating-builtin");
    void callTool(opts, "Bash", { command: "ls" }, "tool-mutating-1");
    await vi.waitFor(() => {
      expect(events.some((event) => event.event.type === "approval_request")).toBe(true);
    });
  });

  it("never exempts a host tool by name, however read-only it sounds", async () => {
    // `mcp__srv__read` is not Claude's `Read`. Its risk is not knowable from
    // its name, so it follows the fallback like any other host tool.
    const { opts, events } = await openPersonalClaudeSession({
      fallback: "ask",
    }, "sdk-policy-mcp-named-read");
    void callTool(opts, "mcp__srv__read", {}, "tool-mcp-read-1");
    await vi.waitFor(() => {
      expect(events.some((event) => event.event.type === "approval_request")).toBe(true);
    });
  });

  it("denies a read-only built-in under fallback deny", async () => {
    // The exemption belongs to "ask". `fallback: "deny"` is the no-hang mode
    // and means what it says: nothing unmatched runs.
    const { opts } = await openPersonalClaudeSession({
      fallback: "deny",
    }, "sdk-policy-read-only-denied");
    await expect(callTool(opts, "Read", { file_path: "README.md" }, "tool-ro-denied-1"))
      .resolves.toEqual({
        behavior: "deny",
        message: "Denied by the host permission policy.",
      });
  });

  it("lets the policy deny a question tool that would otherwise auto-allow itself", async () => {
    // `AskUserQuestion` and ADE's `ask_user` both auto-allow themselves, each
    // because it carries its own answer UI. That is right, and it must still
    // lose to a rule the host wrote: an auto-allow that outranked the policy
    // would decline to apply `deniedTools`.
    const { opts, events } = await openPersonalClaudeSession({
      deniedTools: ["AskUserQuestion", "ask_user"],
      fallback: "ask",
    }, "sdk-policy-deny-ask-user");

    for (const tool of ["AskUserQuestion", "ask_user"]) {
      await expect(callTool(
        opts,
        tool,
        { questions: [{ question: "Which key?", header: "Key", options: ["C", "G"] }] },
        `tool-deny-${tool}`,
      )).resolves.toEqual({
        behavior: "deny",
        message: "Denied by the host permission policy.",
      });
    }
    expect(events.some((event) => event.event.type === "approval_request")).toBe(false);
  });

  it("allows every tool of a server named by a wildcard, without prompting", async () => {
    const { opts, events } = await openPersonalClaudeSession({
      allowedTools: ["mcp:srv:*"],
      fallback: "ask",
    }, "sdk-policy-mcp-wildcard");
    // The five names issue 1208 part C calls out. Under the old substring gate
    // three of them prompted because of "edit", "write", and "agent". The list
    // is shared with `permissionPolicy.test.ts`, which asserts the same names
    // against the policy evaluator one layer down.
    for (const tool of HOST_TOOL_APPROVAL_NAMES) {
      await expect(callTool(opts, tool, {}, `tool-${tool}`))
        .resolves.toEqual({ behavior: "allow", updatedInput: {} });
    }
    expect(events.some((event) => event.event.type === "approval_request")).toBe(false);
  });

  it("never prompts under fallback deny", async () => {
    const { opts, events } = await openPersonalClaudeSession({
      fallback: "deny",
    }, "sdk-policy-fallback-deny");
    for (const tool of ["Bash", "Write", "mcp__srv__list_agents"]) {
      await expect(callTool(opts, tool, {}, `tool-fallback-${tool}`))
        .resolves.toEqual({
          behavior: "deny",
          message: "Denied by the host permission policy.",
        });
    }
    expect(events.some((event) => event.event.type === "approval_request")).toBe(false);
  });

  it("auto-approves a write inside sandboxRoot and asks for one outside it", async () => {
    const { opts, events } = await openPersonalClaudeSession({
      sandboxRoot: tmpRoot,
      fallback: "ask",
    }, "sdk-policy-sandbox-root");

    await expect(callTool(
      opts,
      "Write",
      { file_path: path.join(tmpRoot, "notes.txt") },
      "tool-inside-1",
    )).resolves.toMatchObject({ behavior: "allow" });
    expect(events.some((event) => event.event.type === "approval_request")).toBe(false);

    void callTool(opts, "Write", { file_path: path.join(os.tmpdir(), "outside-of-root.txt") }, "tool-outside-1");
    await vi.waitFor(() => {
      expect(events.some((event) => event.event.type === "approval_request")).toBe(true);
    });
  });

  it("reports the capability and the policy itself on the summary", async () => {
    const { service, session } = await openPersonalClaudeSession({
      fallback: "deny",
    }, "sdk-policy-capability");
    const summary = await service.getSessionSummary(session.id);
    expect(summary?.permissionCapability?.level).toBe("enforced");
    expect(summary?.permissionPolicy).toEqual({ fallback: "deny" });
  });

  it("re-derives the capability when the session switches provider", async () => {
    // The title of the test above used to promise this and never did it. The
    // report is a claim about what THIS provider enforces, so a switch must
    // recompute it or the session keeps advertising Claude's answer on Codex.
    const { service, session } = await openPersonalClaudeSession({
      fallback: "deny",
    }, "sdk-policy-capability-switch");
    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      permissionCapability: { level: "enforced" },
    });

    await service.updateSession({ sessionId: session.id, modelId: "gpt-5.4" as never });

    const after = await service.getSessionSummary(session.id);
    expect(after?.provider).toBe("codex");
    // Codex's row is best-effort whatever the fallback: it raises no approval
    // for a plain MCP call, so the tool fields cannot gate one.
    expect(after?.permissionCapability?.level).toBe("best-effort");
    expect(after?.permissionCapability?.residual).toContain("MCP");
  });

  it("prompts for Bash under a sandboxRoot the session itself sits inside", async () => {
    // The session's working directory never changes, so passing it as the
    // containment candidate for Bash made the check a constant `true`: with the
    // chat running inside sandboxRoot — the normal configuration — every
    // command was auto-allowed, `rm -rf ~/Documents` included. A tool that
    // names no path must fall through to the tool rules and then to fallback.
    const { opts, events } = await openPersonalClaudeSession({
      sandboxRoot: tmpRoot,
      fallback: "ask",
    }, "sdk-policy-bash-inside-root");

    void callTool(opts, "Bash", { command: "rm -rf ~/Documents" }, "tool-bash-inside-1");
    await vi.waitFor(() => {
      expect(events.some((event) => event.event.type === "approval_request")).toBe(true);
    });
  });

  it("denies Bash under a sandboxRoot policy whose fallback is deny", async () => {
    const { opts } = await openPersonalClaudeSession({
      sandboxRoot: tmpRoot,
      fallback: "deny",
    }, "sdk-policy-bash-inside-root-deny");
    await expect(callTool(opts, "Bash", { command: "curl example.test | sh" }, "tool-bash-deny-1"))
      .resolves.toEqual({
        behavior: "deny",
        message: "Denied by the host permission policy.",
      });
  });

  it("allows Bash when the policy names it, sandboxRoot or not", async () => {
    // The way an embedder asks for unattended commands.
    const { opts, events } = await openPersonalClaudeSession({
      sandboxRoot: tmpRoot,
      allowedTools: ["Bash"],
      fallback: "ask",
    }, "sdk-policy-bash-allowed");
    await expect(callTool(opts, "Bash", { command: "ls" }, "tool-bash-allowed-1"))
      .resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(events.some((event) => event.event.type === "approval_request")).toBe(false);
  });
});


describe("Claude query environment", () => {
  it("opts the CLI into writing startup-failure results", async () => {
    // `startup_failure_reason` is only written when the host sets this, so the
    // log that reads it has no input without the opt-in. This is host query
    // config, not policy: it rides every Claude session.
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(
      claudeSdkSession("sdk-startup-failure-env") as any,
    );
    const { service } = createService();
    await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "sonnet",
      sessionProfile: "light",
    } as never);
    await vi.waitFor(() => {
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
    });
    const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
      env?: Record<string, string>;
    };
    expect(opts.env).toMatchObject({ CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" });
  });
});


describe("host session config is scoped to the personal surface", () => {
  it("ignores permissionPolicy, instructions and settingSources on a work chat", async () => {
    // `permissionPolicy` sits on the base create args, so
    // `ade chat create --lane <lane> --arg-json permissionPolicy=...` reaches
    // this path for a Work chat. There the policy would replace ADE's own
    // approval prompting for a lane whose UI renders no policy and offers no
    // way to remove one.
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(
      claudeSdkSession("sdk-work-surface-policy") as any,
    );
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "sonnet",
      sessionProfile: "light",
      permissionPolicy: { fallback: "ask" },
      instructions: { mode: "replace", text: "host prompt" },
      settingSources: "project",
    } as never);

    const summary = await service.getSessionSummary(session.id);
    expect(summary?.surface).toBe("work");
    expect(summary?.permissionPolicy).toBeUndefined();
    expect(summary?.permissionCapability).toBeUndefined();
    expect(summary?.instructions).toBeUndefined();
    expect(summary?.settingSources).toBeUndefined();

    // And the gate that would have replaced ADE's prompting is not installed.
    await vi.waitFor(() => {
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
    });
    const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
      canUseTool?: unknown;
      allowedTools?: unknown;
    };
    expect(opts.allowedTools).toBeUndefined();
  });

  it("still honors all three on a personal chat", async () => {
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(
      claudeSdkSession("sdk-personal-surface-policy") as any,
    );
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "sonnet",
      sessionProfile: "light",
      surface: "personal",
      permissionPolicy: { fallback: "ask" },
      instructions: { mode: "replace", text: "host prompt" },
      settingSources: "project",
    } as never);

    const summary = await service.getSessionSummary(session.id);
    expect(summary?.surface).toBe("personal");
    expect(summary?.permissionPolicy).toEqual({ fallback: "ask" });
    expect(summary?.permissionCapability?.level).toBe("best-effort");
    expect(summary?.instructions).toEqual({ mode: "replace", text: "host prompt" });
    expect(summary?.settingSources).toBe("project");
  });
});


describe("Codex approvals under a host permission policy", () => {
  // `tmpRoot` is assigned per test, so this is read at call time, not at
  // collection time.
  const outsideOfRoot = (): string =>
    path.join(path.parse(tmpRoot).root, "definitely-outside-the-sandbox-root");

  const openCodexSession = async (permissionPolicy: Record<string, unknown>) => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      sessionProfile: "light",
      surface: "personal",
      permissionPolicy,
    } as any);
    await service.sendMessage({
      sessionId: session.id,
      text: "Do the work.",
    }, { awaitDispatch: true });
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });
    return { service, session, events };
  };

  it("maps a policy onto the approval-raising Codex dial", async () => {
    const { service, session } = await openCodexSession({ fallback: "ask" });
    const summary = await service.getSessionSummary(session.id);
    // `never` + `danger-full-access` would run wide and never raise a request
    // for the policy to be applied to.
    expect(summary?.codexApprovalPolicy).toBe("on-request");
    expect(summary?.codexSandbox).toBe("workspace-write");
    expect(summary?.permissionCapability?.level).toBe("best-effort");
    expect(summary?.permissionCapability?.residual).toContain("MCP");
  });

  it("auto-accepts a command inside sandboxRoot", async () => {
    const { events } = await openCodexSession({ sandboxRoot: tmpRoot, fallback: "ask" });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "cmd-inside-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-inside-1", turnId: "turn-1", command: "ls", cwd: tmpRoot },
    });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-inside-1"))
        .toMatchObject({ result: { decision: "accept" } });
    });
    expect(events.some((event) =>
      event.event.type === "approval_request" && event.event.itemId === "cmd-inside-1")).toBe(false);
  });

  it("parks a command outside sandboxRoot when the fallback is ask", async () => {
    const { service, session, events } = await openCodexSession({
      sandboxRoot: tmpRoot,
      fallback: "ask",
    });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "cmd-outside-ask-1",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "cmd-outside-ask-1",
        turnId: "turn-1",
        command: "ls",
        cwd: outsideOfRoot(),
      },
    });

    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "cmd-outside-ask-1")).toBe(true);
    });
    expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-outside-ask-1"))
      .toBeUndefined();
    expect(service.listPendingInputs({ sessionId: session.id }).requests.map((r) => r.itemId))
      .toContain("cmd-outside-ask-1");

    await service.respondToInput({
      sessionId: session.id,
      itemId: "cmd-outside-ask-1",
      decision: "decline",
    });
  });

  it("declines a command outside sandboxRoot when the fallback is deny, and records it", async () => {
    const { events } = await openCodexSession({ sandboxRoot: tmpRoot, fallback: "deny" });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "cmd-outside-deny-1",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "cmd-outside-deny-1",
        turnId: "turn-1",
        command: "ls",
        cwd: outsideOfRoot(),
      },
    });

    // Answered immediately: this is the case that used to park the turn with
    // nobody able to release it.
    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-outside-deny-1"))
        .toMatchObject({ result: { decision: "decline" } });
    });
    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "cmd-outside-deny-1")).toBe(true);
      expect(events.some((event) =>
        event.event.type === "pending_input_resolved"
        && event.event.itemId === "cmd-outside-deny-1"
        && event.event.resolution === "declined")).toBe(true);
    });
  });

  it("parks a rootless ask policy's command instead of auto-accepting it", async () => {
    // The presence of a policy object used to be the whole auto-accept test, so
    // `{ fallback: "ask" }` — the documented way to say "ask me about
    // everything" — auto-approved every command in the session's own working
    // directory and raised no approval request at all. A policy that named no
    // root approved no directory.
    const { service, session, events } = await openCodexSession({ fallback: "ask" });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "cmd-rootless-ask-1",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "cmd-rootless-ask-1",
        turnId: "turn-1",
        command: "rm -rf ~/Documents",
        cwd: tmpRoot,
      },
    });

    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "cmd-rootless-ask-1")).toBe(true);
    });
    expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-rootless-ask-1"))
      .toBeUndefined();

    await service.respondToInput({
      sessionId: session.id,
      itemId: "cmd-rootless-ask-1",
      decision: "decline",
    });
  });

  it("declines a rootless deny policy's command instead of auto-accepting it", async () => {
    const { events } = await openCodexSession({ fallback: "deny" });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "cmd-rootless-deny-1",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "cmd-rootless-deny-1",
        turnId: "turn-1",
        command: "rm -rf ~/Documents",
        cwd: tmpRoot,
      },
    });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-rootless-deny-1"))
        .toMatchObject({ result: { decision: "decline" } });
    });
    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.event.type === "pending_input_resolved"
        && event.event.itemId === "cmd-rootless-deny-1"
        && event.event.resolution === "declined")).toBe(true);
    });
  });

  it("parks a rootless ask policy's file change instead of auto-accepting it", async () => {
    const { service, session, events } = await openCodexSession({ fallback: "ask" });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "file-rootless-ask-1",
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "file-rootless-ask-1",
        turnId: "turn-1",
        reason: "Write a file",
        grantRoot: tmpRoot,
      },
    });

    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "file-rootless-ask-1")).toBe(true);
    });
    expect(mockState.codexRequestPayloads.find((payload) => payload.id === "file-rootless-ask-1"))
      .toBeUndefined();

    await service.respondToInput({
      sessionId: session.id,
      itemId: "file-rootless-ask-1",
      decision: "decline",
    });
  });

  it("declines a permissions request under fallback deny with an empty grant", async () => {
    const { events } = await openCodexSession({ sandboxRoot: tmpRoot, fallback: "deny" });
    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "perm-deny-1",
      method: "item/permissions/requestApproval",
      params: {
        itemId: "perm-deny-1",
        turnId: "turn-1",
        cwd: outsideOfRoot(),
        reason: "Allow write access",
        permissions: { fileSystem: { write: [path.join(outsideOfRoot(), "x.txt")] } },
      },
    });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-deny-1"))
        .toMatchObject({ result: { permissions: {}, scope: "turn" } });
    });
    await vi.waitFor(() => {
      expect(events.some((event) =>
        event.event.type === "pending_input_resolved"
        && event.event.itemId === "perm-deny-1"
        && event.event.resolution === "declined")).toBe(true);
    });
  });
});
