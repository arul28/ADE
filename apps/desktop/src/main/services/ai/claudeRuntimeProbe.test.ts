import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  query: vi.fn(),
  reportProviderRuntimeReady: vi.fn(),
  reportProviderRuntimeAuthFailure: vi.fn(),
  reportProviderRuntimeFailure: vi.fn(),
  claudeExecutable: { path: "claude", source: "fallback-command" } as { path: string; source: string },
  pinnedToolFetchPending: vi.fn((_tool: string) => false),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockState.query(...args),
}));

vi.mock("./claudeCodeExecutable", () => ({
  resolveClaudeCodeExecutable: () => mockState.claudeExecutable,
  isExecutablePath: (candidate: string) => candidate.includes("/"),
}));

vi.mock("../../../../../ade-cli/src/services/tools/cacheLookup", () => ({
  pinnedToolFetchPending: (tool: string) => mockState.pinnedToolFetchPending(tool),
}));

vi.mock("./providerRuntimeHealth", () => ({
  reportProviderRuntimeReady: (...args: unknown[]) => mockState.reportProviderRuntimeReady(...args),
  reportProviderRuntimeAuthFailure: (...args: unknown[]) => mockState.reportProviderRuntimeAuthFailure(...args),
  reportProviderRuntimeFailure: (...args: unknown[]) => mockState.reportProviderRuntimeFailure(...args),
}));

let probeClaudeRuntimeHealth: typeof import("./claudeRuntimeProbe").probeClaudeRuntimeHealth;
let resetClaudeRuntimeProbeCache: typeof import("./claudeRuntimeProbe").resetClaudeRuntimeProbeCache;
let isClaudeRuntimeAuthError: typeof import("./claudeRuntimeProbe").isClaudeRuntimeAuthError;

function makeStream(messages: unknown[]) {
  const close = vi.fn();
  const stream = {
    close,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
  };
  return { close, stream };
}

beforeEach(async () => {
  vi.resetModules();
  mockState.query.mockReset();
  mockState.reportProviderRuntimeReady.mockReset();
  mockState.reportProviderRuntimeAuthFailure.mockReset();
  mockState.reportProviderRuntimeFailure.mockReset();
  mockState.claudeExecutable = { path: "claude", source: "fallback-command" };
  mockState.pinnedToolFetchPending.mockReset();
  mockState.pinnedToolFetchPending.mockReturnValue(false);
  const mod = await import("./claudeRuntimeProbe");
  probeClaudeRuntimeHealth = mod.probeClaudeRuntimeHealth;
  resetClaudeRuntimeProbeCache = mod.resetClaudeRuntimeProbeCache;
  isClaudeRuntimeAuthError = mod.isClaudeRuntimeAuthError;
  resetClaudeRuntimeProbeCache();
});

describe("claudeRuntimeProbe", () => {
  it("closes the Claude probe stream when auth fails early", async () => {
    const query = makeStream([
      {
        type: "auth_status",
        isAuthenticating: false,
        output: [],
        error: "login required",
        uuid: "uuid-1",
        session_id: "session-1",
      },
    ]);
    mockState.query.mockReturnValue(query.stream);

    await probeClaudeRuntimeHealth({ projectRoot: "/tmp/project", force: true });

    expect(query.close).toHaveBeenCalledTimes(1);
    expect(mockState.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        tools: [],
        pathToClaudeCodeExecutable: expect.any(String),
      }),
    }));
    expect(mockState.reportProviderRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockState.reportProviderRuntimeFailure).not.toHaveBeenCalled();
    expect(mockState.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        cwd: "/tmp/project",
        tools: [],
      }),
    }));
  });

  it("treats Anthropic 401 invalid credentials responses as auth failures", async () => {
    expect(
      isClaudeRuntimeAuthError(
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
      ),
    ).toBe(true);

    const query = makeStream([
      {
        type: "result",
        subtype: "success",
        duration_ms: 12,
        duration_api_ms: 12,
        is_error: true,
        num_turns: 1,
        result: "",
        session_id: "session-401",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 0 },
          service_tier: "standard",
        },
        errors: [
          'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
        ],
      },
    ]);
    mockState.query.mockReturnValue(query.stream);

    await probeClaudeRuntimeHealth({ projectRoot: "/tmp/project", force: true });

    expect(query.close).toHaveBeenCalledTimes(1);
    expect(mockState.reportProviderRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockState.reportProviderRuntimeFailure).not.toHaveBeenCalled();
  });

  it("probes Claude with an empty tool list", async () => {
    const query = makeStream([
      {
        type: "result",
        subtype: "success",
        duration_ms: 50,
        duration_api_ms: 50,
        is_error: false,
        num_turns: 1,
        result: "ok",
        session_id: "session-ok",
        total_cost_usd: 0.001,
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 5,
          server_tool_use: { web_search_requests: 0 },
          service_tier: "standard",
        },
      },
    ]);
    mockState.query.mockReturnValue(query.stream);

    await probeClaudeRuntimeHealth({ projectRoot: "/my/custom/project", force: true });

    expect(mockState.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        tools: [],
      }),
    }));
    expect(mockState.reportProviderRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it("reports runtime-failed when the probe stream throws an error", async () => {
    mockState.query.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    await probeClaudeRuntimeHealth({ projectRoot: "/tmp/project", force: true });

    expect(mockState.reportProviderRuntimeFailure).toHaveBeenCalledTimes(1);
    expect(mockState.reportProviderRuntimeAuthFailure).not.toHaveBeenCalled();
    expect(mockState.reportProviderRuntimeFailure).toHaveBeenCalledWith("claude", "spawn ENOENT");
  });

  // First run on a cold tools cache: nothing resolved because the pinned
  // runtime is still downloading. Passing the SDK's raw "not found" through
  // there reads as a broken install, which it is not.
  it("says the runtime is still downloading when the pinned fetch is pending", async () => {
    mockState.query.mockImplementation(() => {
      throw new Error("Claude Code native binary not found");
    });
    mockState.pinnedToolFetchPending.mockReturnValue(true);

    await probeClaudeRuntimeHealth({ projectRoot: "/tmp/project", force: true });

    expect(mockState.pinnedToolFetchPending).toHaveBeenCalledWith("claude-code");
    expect(mockState.reportProviderRuntimeFailure).toHaveBeenCalledWith(
      "claude",
      "ADE is still downloading the Claude Code runtime (first-run setup). "
      + "It retries automatically — see Settings → AI Runtimes.",
    );
  });

  // A resolved executable that fails to spawn is a real problem even mid-fetch,
  // so the pending copy must not swallow it.
  it("keeps the real diagnosis when an executable did resolve", async () => {
    mockState.claudeExecutable = { path: "/opt/tools/claude", source: "tools-cache" };
    mockState.query.mockImplementation(() => {
      throw new Error("Claude Code native binary not found");
    });
    mockState.pinnedToolFetchPending.mockReturnValue(true);

    await probeClaudeRuntimeHealth({ projectRoot: "/tmp/project", force: true });

    expect(mockState.pinnedToolFetchPending).not.toHaveBeenCalled();
    expect(mockState.reportProviderRuntimeFailure).toHaveBeenCalledWith(
      "claude",
      expect.stringContaining("failed to spawn resolved executable /opt/tools/claude"),
    );
  });
});
