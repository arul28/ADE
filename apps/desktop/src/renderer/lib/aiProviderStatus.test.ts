import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, AiSettingsStatus } from "../../shared/types";
import { hasConfiguredAiProvider, shouldRefreshAiStatusForChatEvent } from "./aiProviderStatus";

function makeStatus(overrides: Partial<AiSettingsStatus> = {}): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: {
          present: false,
          source: "missing",
          path: null,
        },
        auth: {
          ready: false,
          mode: "none",
          detail: null,
        },
      },
      codex: false,
      cursor: false,
      droid: false,
    },
    models: {
      claude: [],
      codex: [],
      cursor: [],
      droid: [],
    },
    features: [],
    ...overrides,
  };
}

function chatEvent(event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: "2026-05-28T00:00:00.000Z",
    event,
  };
}

describe("hasConfiguredAiProvider", () => {
  it("returns false without a provider status", () => {
    expect(hasConfiguredAiProvider(null)).toBe(false);
    expect(hasConfiguredAiProvider(undefined)).toBe(false);
  });

  it("returns false for an empty provider status", () => {
    expect(hasConfiguredAiProvider(makeStatus())).toBe(false);
  });

  it("recognizes all provider connection families", () => {
    expect(
      hasConfiguredAiProvider(
        makeStatus({
          providerConnections: {
            claude: {
              provider: "claude",
              authAvailable: false,
              runtimeDetected: false,
              runtimeAvailable: false,
              usageAvailable: false,
              path: null,
              blocker: null,
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
            codex: {
              provider: "codex",
              authAvailable: false,
              runtimeDetected: false,
              runtimeAvailable: false,
              usageAvailable: false,
              path: null,
              blocker: null,
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
            cursor: {
              provider: "cursor",
              authAvailable: false,
              runtimeDetected: false,
              runtimeAvailable: false,
              usageAvailable: false,
              path: null,
              blocker: null,
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
            droid: {
              provider: "droid",
              authAvailable: true,
              runtimeDetected: true,
              runtimeAvailable: true,
              usageAvailable: true,
              path: "/bin/droid",
              blocker: null,
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("recognizes available provider and model signals even without providerConnections", () => {
    expect(
      hasConfiguredAiProvider(
        makeStatus({
          availableProviders: {
            claude: {
              binary: {
                present: true,
                source: "bundled",
                path: "/bundle/claude",
              },
              auth: {
                ready: false,
                mode: "none",
                detail: null,
              },
            },
            codex: true,
            cursor: false,
            droid: false,
          },
        }),
      ),
    ).toBe(true);

    expect(
      hasConfiguredAiProvider(
        makeStatus({
          availableModelIds: ["opencode/openai/gpt-5.4-mini"],
        }),
      ),
    ).toBe(true);
  });

  it("does not treat a bundled Claude binary as configured without auth", () => {
    expect(
      hasConfiguredAiProvider(
        makeStatus({
          availableProviders: {
            claude: {
              binary: {
                present: true,
                source: "bundled",
                path: "/bundle/claude",
              },
              auth: {
                ready: false,
                mode: "none",
                detail: null,
              },
            },
            codex: false,
            cursor: false,
            droid: false,
          },
        }),
      ),
    ).toBe(false);
  });

  it("recognizes usable runtime connections", () => {
    expect(
      hasConfiguredAiProvider(
        makeStatus({
          runtimeConnections: {
            lmstudio: {
              provider: "lmstudio",
              label: "LM Studio",
              kind: "local",
              configured: true,
              authAvailable: true,
              runtimeDetected: true,
              runtimeAvailable: true,
              health: "ready",
              endpoint: "http://localhost:1234",
              blocker: null,
              loadedModelIds: ["lmstudio/local-model"],
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("does not recognize unusable provider or runtime connections", () => {
    expect(
      hasConfiguredAiProvider(
        makeStatus({
          providerConnections: {
            claude: {
              provider: "claude",
              authAvailable: false,
              runtimeDetected: false,
              runtimeAvailable: false,
              usageAvailable: false,
              path: null,
              blocker: "Claude is not configured.",
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
            codex: {
              provider: "codex",
              authAvailable: false,
              runtimeDetected: false,
              runtimeAvailable: false,
              usageAvailable: false,
              path: null,
              blocker: "Codex is not configured.",
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
            cursor: {
              provider: "cursor",
              authAvailable: false,
              runtimeDetected: false,
              runtimeAvailable: false,
              usageAvailable: false,
              path: null,
              blocker: "Cursor is not configured.",
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
            droid: {
              provider: "droid",
              authAvailable: false,
              runtimeDetected: false,
              runtimeAvailable: false,
              usageAvailable: false,
              path: null,
              blocker: "Factory Droid is not configured.",
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
              sources: [],
            },
          },
          runtimeConnections: {
            lmstudio: {
              provider: "lmstudio",
              label: "LM Studio",
              kind: "local",
              configured: true,
              authAvailable: false,
              runtimeDetected: true,
              runtimeAvailable: false,
              health: "reachable_no_models",
              endpoint: "http://localhost:1234",
              blocker: "LM Studio has no loaded models.",
              loadedModelIds: [],
              lastCheckedAt: "2026-05-28T00:00:00.000Z",
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("recognizes usable detected auth and ignores verified failed CLI auth", () => {
    expect(
      hasConfiguredAiProvider(
        makeStatus({
          detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: false, verified: true }],
        }),
      ),
    ).toBe(false);

    expect(
      hasConfiguredAiProvider(
        makeStatus({
          detectedAuth: [{ type: "cli-subscription", cli: "claude", authenticated: false, verified: false }],
        }),
      ),
    ).toBe(true);

    expect(
      hasConfiguredAiProvider(
        makeStatus({
          detectedAuth: [{ type: "api-key", provider: "openai", source: "store", verified: true }],
        }),
      ),
    ).toBe(true);
  });

  it("recognizes connected OpenCode providers", () => {
    expect(
      hasConfiguredAiProvider(
        makeStatus({
          opencodeProviders: [
            { id: "openai", name: "OpenAI", connected: false, modelCount: 1 },
            { id: "anthropic", name: "Anthropic", connected: true, modelCount: 1 },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("detects auth-related chat events that should refresh provider status", () => {
    expect(
      shouldRefreshAiStatusForChatEvent(chatEvent({
        type: "system_notice",
        noticeKind: "auth",
        message: "Please sign in again.",
      })),
    ).toBe(true);

    expect(
      shouldRefreshAiStatusForChatEvent(chatEvent({
        type: "error",
        message: "Invalid API key.",
      })),
    ).toBe(true);

    expect(
      shouldRefreshAiStatusForChatEvent(chatEvent({
        type: "status",
        turnStatus: "failed",
        message: "Authentication failed.",
      })),
    ).toBe(true);

    expect(
      shouldRefreshAiStatusForChatEvent(chatEvent({
        type: "status",
        turnStatus: "failed",
        message: "The command exited with status 1.",
      })),
    ).toBe(false);
  });
});
