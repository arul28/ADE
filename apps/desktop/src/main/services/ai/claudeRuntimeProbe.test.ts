import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  query: vi.fn(),
  reportProviderRuntimeReady: vi.fn(),
  reportProviderRuntimeAuthFailure: vi.fn(),
  reportProviderRuntimeFailure: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockState.query(...args),
}));

vi.mock("./providerRuntimeHealth", () => ({
  reportProviderRuntimeReady: (...args: unknown[]) => mockState.reportProviderRuntimeReady(...args),
  reportProviderRuntimeAuthFailure: (...args: unknown[]) => mockState.reportProviderRuntimeAuthFailure(...args),
  reportProviderRuntimeFailure: (...args: unknown[]) => mockState.reportProviderRuntimeFailure(...args),
}));

let probeClaudeRuntimeHealth: typeof import("./claudeRuntimeProbe").probeClaudeRuntimeHealth;
let resetClaudeRuntimeProbeCache: typeof import("./claudeRuntimeProbe").resetClaudeRuntimeProbeCache;

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
  const mod = await import("./claudeRuntimeProbe");
  probeClaudeRuntimeHealth = mod.probeClaudeRuntimeHealth;
  resetClaudeRuntimeProbeCache = mod.resetClaudeRuntimeProbeCache;
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
    expect(mockState.reportProviderRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    expect(mockState.reportProviderRuntimeFailure).not.toHaveBeenCalled();
  });
});
