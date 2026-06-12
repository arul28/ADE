/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersSection } from "./ProvidersSection";
import type { AgentChatEventEnvelope, AiSettingsStatus } from "../../../shared/types";

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Anthropic: brand(),
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    Gemini: brand(),
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    Kimi: brand(),
    LmStudio: brand(),
    Ollama: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    XAI: brand(),
  };
});

function buildStatus(
  claudeRuntimeAvailable: boolean,
  localModels: string[] = [],
  options?: {
    claudeBinaryPresent?: boolean;
    claudeAuthReady?: boolean;
    localRuntimeDetected?: boolean;
    localRuntimeAvailable?: boolean;
    localRuntimeHealth?: "ready" | "reachable" | "reachable_no_models" | "not_configured" | "unreachable";
    localRuntimeBlocker?: string | null;
  },
): AiSettingsStatus {
  const claudeBinaryPresent = options?.claudeBinaryPresent ?? claudeRuntimeAvailable;
  const claudeAuthReady = options?.claudeAuthReady ?? claudeRuntimeAvailable;
  const localRuntimeDetected = options?.localRuntimeDetected ?? localModels.length > 0;
  const localRuntimeAvailable = options?.localRuntimeAvailable ?? localModels.length > 0;
  const localRuntimeHealth =
    options?.localRuntimeHealth
    ?? (localRuntimeAvailable ? "ready" : localRuntimeDetected ? "reachable_no_models" : "unreachable");
  const localRuntimeBlocker =
    options?.localRuntimeBlocker
    ?? (localRuntimeAvailable
      ? null
      : localRuntimeDetected
        ? "LM Studio is reachable, but no models are currently loaded."
        : "No lmstudio runtime with loaded models was detected.");

  return {
    mode: "subscription",
    availableProviders: {
      claude: {
        binary: {
          present: claudeBinaryPresent,
          source: claudeBinaryPresent ? "bundled" : "missing",
          path: claudeBinaryPresent ? "/Users/arul/ADE/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" : null,
        },
        auth: {
          ready: claudeAuthReady,
          mode: claudeAuthReady ? "oauth" : "none",
          detail: claudeAuthReady ? null : "Sign in to use Claude",
        },
      },
      codex: true,
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
    detectedAuth: localModels.length > 0
      || localRuntimeDetected
      ? [
          {
            type: "local",
            provider: "lmstudio",
            endpoint: "http://localhost:1234",
          },
        ]
      : [],
    availableModelIds: localModels,
    runtimeConnections: {
      lmstudio: {
        provider: "lmstudio",
        label: "LM Studio",
        kind: "local",
        endpoint: "http://localhost:1234",
        configured: true,
        authAvailable: false,
        runtimeDetected: localRuntimeDetected,
        runtimeAvailable: localRuntimeAvailable,
        health: localRuntimeHealth,
        blocker: localRuntimeBlocker,
        loadedModelIds: localModels,
        lastCheckedAt: "2026-03-17T19:00:00.000Z",
      },
    },
    providerConnections: {
      claude: {
        provider: "claude",
        authAvailable: true,
        runtimeDetected: true,
        runtimeAvailable: claudeRuntimeAvailable,
        usageAvailable: claudeRuntimeAvailable,
        path: "/Users/arul/.local/bin/claude",
        blocker: claudeRuntimeAvailable ? null : "Authentication required",
        lastCheckedAt: "2026-03-17T19:00:00.000Z",
        sources: [
          {
            kind: "local-credentials",
            detected: true,
            source: "claude-credentials-file",
            authenticated: !claudeRuntimeAvailable ? false : true,
          },
        ],
      },
      codex: {
        provider: "codex",
        authAvailable: true,
        runtimeDetected: true,
        runtimeAvailable: true,
        usageAvailable: true,
        path: "/Users/arul/ADE/apps/desktop/node_modules/.bin/codex",
        blocker: null,
        lastCheckedAt: "2026-03-17T19:00:00.000Z",
        sources: [],
      },
      cursor: {
        provider: "cursor",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "Enter a Cursor API key from https://cursor.com/dashboard/api.",
        lastCheckedAt: "2026-03-17T19:00:00.000Z",
        sources: [],
      },
      droid: {
        provider: "droid",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "No Factory Droid CLI (`droid`) or FACTORY_API_KEY was found locally.",
        lastCheckedAt: "2026-03-17T19:00:00.000Z",
        sources: [],
      },
    },
    apiKeyStore: {
      secureStorageAvailable: true,
      legacyPlaintextDetected: false,
      decryptionFailed: false,
    },
  };
}

describe("ProvidersSection", () => {
  const originalAde = globalThis.window.ade;
  let emitChatEvent: ((envelope: AgentChatEventEnvelope) => void) | null = null;

  beforeEach(() => {
    emitChatEvent = null;

    globalThis.window.ade = {
      ai: {
        getStatus: vi.fn()
          .mockResolvedValueOnce(buildStatus(true, ["lmstudio/meta-llama-3.1-70b-instruct", "lmstudio/qwen2.5-coder:32b"]))
          .mockResolvedValueOnce(buildStatus(false, ["lmstudio/meta-llama-3.1-70b-instruct", "lmstudio/qwen2.5-coder:32b"], {
            claudeBinaryPresent: true,
            claudeAuthReady: false,
          })),
        listApiKeys: vi.fn().mockResolvedValue([]),
        storeApiKey: vi.fn().mockResolvedValue(undefined),
        deleteApiKey: vi.fn().mockResolvedValue(undefined),
        verifyApiKey: vi.fn().mockResolvedValue({
          provider: "cursor",
          ok: true,
          message: "Verified",
          source: "store",
          verifiedAt: "2026-03-17T19:00:00.000Z",
        }),
        updateConfig: vi.fn().mockResolvedValue(undefined),
      },
      projectConfig: {
        get: vi.fn().mockResolvedValue({
          effective: {
            ai: {},
          },
        }),
      },
      agentChat: {
        onEvent: vi.fn((listener: (envelope: AgentChatEventEnvelope) => void) => {
          emitChatEvent = listener;
          return () => {
            if (emitChatEvent === listener) {
              emitChatEvent = null;
            }
          };
        }),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("refreshes provider status after an auth-related chat failure", async () => {
    render(<ProvidersSection />);
    const ade = window.ade as any;

    await waitFor(() => {
      expect(ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });
    expect(ade.ai.getStatus).toHaveBeenNthCalledWith(1, {
      force: false,
      refreshOpenCodeInventory: false,
    });

    expect((await screen.findAllByText("/Users/arul/ADE/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")).length).toBeGreaterThan(0);

    act(() => {
      emitChatEvent?.({
        sessionId: "session-1",
        timestamp: "2026-03-17T19:03:02.895Z",
        event: {
          type: "error",
          message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
      });
    });

    await waitFor(() => {
      expect(ade.ai.getStatus).toHaveBeenCalledTimes(2);
      expect(ade.ai.listApiKeys).toHaveBeenCalledTimes(2);
    }, { timeout: 2_000 });

    expect(await screen.findByText("Sign-In Required")).toBeTruthy();
    expect(screen.getByText("Sign in to use Claude")).toBeTruthy();
    expect(screen.getAllByText("/Users/arul/ADE/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude").length).toBeGreaterThan(0);
  });

  it("shows Ready while the bundled Claude runtime is authenticated", async () => {
    render(<ProvidersSection />);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    expect(screen.getByText("Bundled Claude Agent SDK runtime")).toBeTruthy();
    expect(screen.getAllByText("/Users/arul/ADE/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude").length).toBeGreaterThan(0);
  });

  it("shows Binary Missing when the Claude SDK native binary is unavailable", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(false, [], {
      claudeBinaryPresent: false,
      claudeAuthReady: false,
    }));

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText("Binary Missing")).toBeTruthy();
    expect(screen.getByText("Claude unavailable (binary missing; should not happen with bundled install; run /doctor).")).toBeTruthy();
  });

  it("renders local runtime details and loaded local models", async () => {
    render(<ProvidersSection />);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect((await screen.findAllByText("LM Studio")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("LM Studio is reachable at http://localhost:1234. ADE can use 2 loaded models from this runtime (ready).").length).toBeGreaterThan(0);
    expect(screen.getAllByText("meta-llama-3.1-70b-instruct (LM Studio)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("qwen2.5-coder:32b (LM Studio)").length).toBeGreaterThan(0);
  });

  it("shows a warning state when a local runtime is detected without loaded models", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(
      buildStatus(true, [], {
        localRuntimeDetected: true,
        localRuntimeAvailable: false,
        localRuntimeHealth: "reachable_no_models",
        localRuntimeBlocker: "LM Studio is reachable, but no models are currently loaded.",
      }),
    );

    const view = render(<ProvidersSection />);
    const current = within(view.container);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect(await current.findByText("Load a model")).toBeTruthy();
    expect(current.getByText("LM Studio is reachable, but no models are currently loaded.")).toBeTruthy();
    expect(current.queryByText("LM Studio is reachable at http://localhost:1234. ADE can use 2 loaded models from this runtime (ready).")).toBeNull();
  });

  it("keeps Cursor API key setup in the Cursor runtime card and verifies on save", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock
      .mockResolvedValueOnce([])
      .mockResolvedValue(["cursor"]);

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      screen.getByLabelText("Add Cursor API key").click();
    });

    fireEvent.change(screen.getByLabelText("Cursor API key"), { target: { value: "crsr_test" } });

    await act(async () => {
      screen.getByLabelText("Save Cursor API key").click();
    });

    await waitFor(() => {
      expect(window.ade.ai.storeApiKey).toHaveBeenCalledWith("cursor", "crsr_test");
      expect(window.ade.ai.verifyApiKey).toHaveBeenCalledWith("cursor");
    });
    expect(await screen.findByText("Cursor connection verified.")).toBeTruthy();
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });

  it("shows failed Cursor verification as a dismissible error", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock
      .mockResolvedValueOnce([])
      .mockResolvedValue(["cursor"]);
    const verifyApiKeyMock = window.ade.ai.verifyApiKey as ReturnType<typeof vi.fn>;
    verifyApiKeyMock.mockResolvedValueOnce({
      provider: "cursor",
      ok: false,
      message: "Verification request failed: Cannot find package '@cursor/sdk'",
      source: "store",
      verifiedAt: "2026-03-17T19:00:00.000Z",
    });

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      screen.getByLabelText("Add Cursor API key").click();
    });

    fireEvent.change(screen.getByLabelText("Cursor API key"), { target: { value: "crsr_test" } });

    await act(async () => {
      screen.getByLabelText("Save Cursor API key").click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cannot find package '@cursor/sdk'");
    expect(screen.queryByText("Cursor verification failed.")).toBeNull();
    expect(screen.queryByText("Invalid key")).toBeNull();
    expect(screen.getByText("Verification failed")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Dismiss error message").click();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("forces a provider status refresh after verifying a stored Cursor API key", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock.mockResolvedValue(["cursor"]);

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      screen.getByLabelText("Verify Cursor API key").click();
    });

    await waitFor(() => {
      expect(window.ade.ai.verifyApiKey).toHaveBeenCalledWith("cursor");
      expect(window.ade.ai.getStatus).toHaveBeenCalledWith({
        force: true,
        refreshOpenCodeInventory: true,
      });
    });
  });
});
