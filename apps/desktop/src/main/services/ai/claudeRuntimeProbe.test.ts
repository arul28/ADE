import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  query: vi.fn(),
  reportProviderRuntimeReady: vi.fn(),
  reportProviderRuntimeAuthFailure: vi.fn(),
  reportProviderRuntimeFailure: vi.fn(),
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/usr/local/bin/claude", source: "path" })),
  normalizeCliMcpServers: vi.fn(() => ({
    ade: {
      type: "stdio",
      command: "node",
      args: ["probe.js"],
      env: { ADE_PROJECT_ROOT: "/tmp/project" },
    },
  })),
  resolveDesktopAdeMcpLaunch: vi.fn(() => ({
    mode: "headless_source",
    command: "node",
    cmdArgs: ["probe.js"],
    env: { ADE_PROJECT_ROOT: "/tmp/project" },
    entryPath: "probe.js",
    runtimeRoot: "/tmp/runtime",
    socketPath: "/tmp/project/.ade/mcp.sock",
    packaged: false,
    resourcesPath: null,
  })),
  resolveRepoRuntimeRoot: vi.fn(() => "/tmp/runtime"),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockState.query(...args),
}));

vi.mock("./providerRuntimeHealth", () => ({
  reportProviderRuntimeReady: (...args: unknown[]) => mockState.reportProviderRuntimeReady(...args),
  reportProviderRuntimeAuthFailure: (...args: unknown[]) => mockState.reportProviderRuntimeAuthFailure(...args),
  reportProviderRuntimeFailure: (...args: unknown[]) => mockState.reportProviderRuntimeFailure(...args),
}));

vi.mock("./claudeCodeExecutable", () => ({
  resolveClaudeCodeExecutable: mockState.resolveClaudeCodeExecutable,
}));

vi.mock("./providerResolver", () => ({
  normalizeCliMcpServers: mockState.normalizeCliMcpServers,
}));

vi.mock("../runtime/adeMcpLaunch", () => ({
  resolveDesktopAdeMcpLaunch: mockState.resolveDesktopAdeMcpLaunch,
  resolveRepoRuntimeRoot: mockState.resolveRepoRuntimeRoot,
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
  mockState.resolveClaudeCodeExecutable.mockClear();
  mockState.normalizeCliMcpServers.mockClear();
  mockState.resolveDesktopAdeMcpLaunch.mockClear();
  mockState.resolveRepoRuntimeRoot.mockClear();
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
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        mcpServers: expect.objectContaining({
          ade: expect.any(Object),
        }),
      }),
    }));
    expect(mockState.reportProviderRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockState.reportProviderRuntimeFailure).not.toHaveBeenCalled();
    expect(mockState.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        cwd: "/tmp/project",
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        mcpServers: expect.objectContaining({
          ade: expect.any(Object),
        }),
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

  it("calls resolveDesktopAdeMcpLaunch with defaultRole external and projectRoot", async () => {
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

    expect(mockState.resolveDesktopAdeMcpLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/my/custom/project",
        workspaceRoot: "/my/custom/project",
        defaultRole: "external",
      }),
    );
    expect(mockState.resolveRepoRuntimeRoot).toHaveBeenCalled();
    expect(mockState.reportProviderRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it("reports runtime-failed when the probe stream throws an error", async () => {
    mockState.query.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    await probeClaudeRuntimeHealth({ projectRoot: "/tmp/project", force: true });

    expect(mockState.reportProviderRuntimeFailure).toHaveBeenCalledTimes(1);
    expect(mockState.reportProviderRuntimeAuthFailure).not.toHaveBeenCalled();
  });
});
