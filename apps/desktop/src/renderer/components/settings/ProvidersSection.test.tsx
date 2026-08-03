/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
    opencodeBinaryInstalled?: boolean;
    opencodeProviders?: Array<{ id: string; name: string; connected: boolean; modelCount: number }>;
    opencodeProvidersStale?: boolean;
    modelsDevLastFetchedAt?: number | null;
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
    opencodeBinaryInstalled: options?.opencodeBinaryInstalled ?? true,
    opencodeBinarySource: (options?.opencodeBinaryInstalled ?? true) ? "bundled" : "missing",
    opencodeProviders: options?.opencodeProviders ?? [],
    ...(options?.opencodeProvidersStale != null ? { opencodeProvidersStale: options.opencodeProvidersStale } : {}),
    ...(options?.modelsDevLastFetchedAt !== undefined ? { modelsDevLastFetchedAt: options.modelsDevLastFetchedAt } : {}),
  } as AiSettingsStatus;
}

function renderProvidersSection() {
  return render(
    <MemoryRouter>
      <ProvidersSection />
    </MemoryRouter>,
  );
}

describe("ProvidersSection", () => {
  const originalAde = globalThis.window.ade;
  let emitChatEvent: ((envelope: AgentChatEventEnvelope) => void) | null = null;
  let emitOAuthStatus: ((event: { providerId: string; state: string; error?: string }) => void) | null = null;

  beforeEach(() => {
    emitChatEvent = null;
    emitOAuthStatus = null;

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
        opencodeAuthMethods: vi.fn().mockResolvedValue({ methods: {} }),
        opencodeOAuthStart: vi.fn().mockResolvedValue({
          url: "https://auth.openai.com/device",
          method: "auto",
          instructions: "Open the page and enter code ABCD-1234 to continue.",
        }),
        opencodeOAuthCancel: vi.fn().mockResolvedValue(undefined),
        setOpencodeProviderKey: vi.fn().mockResolvedValue({ ok: true }),
        clearOpencodeProviderKey: vi.fn().mockResolvedValue({ ok: true }),
        refreshModelsDev: vi.fn().mockResolvedValue({ lastFetchedAt: Date.now() }),
        onOpencodeOAuthStatus: vi.fn((cb: (event: { providerId: string; state: string; error?: string }) => void) => {
          emitOAuthStatus = cb;
          return () => {
            if (emitOAuthStatus === cb) emitOAuthStatus = null;
          };
        }),
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
      builtInBrowser: {
        navigate: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("refreshes provider status after an auth-related chat failure", async () => {
    renderProvidersSection();
    const ade = window.ade as any;

    await waitFor(() => {
      expect(ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });
    expect(ade.ai.getStatus).toHaveBeenNthCalledWith(1, {
      force: false,
      refreshOpenCodeInventory: true,
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
    renderProvidersSection();

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    expect(screen.getByText("Uses your claude login — Claude Pro/Max subscription or ANTHROPIC_API_KEY.")).toBeTruthy();
    expect(screen.getAllByText("/Users/arul/ADE/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude").length).toBeGreaterThan(0);
  });

  it("shows Binary Missing when the Claude SDK native binary is unavailable", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(false, [], {
      claudeBinaryPresent: false,
      claudeAuthReady: false,
    }));

    renderProvidersSection();

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText("Binary Missing")).toBeTruthy();
    expect(screen.getByText("Claude unavailable (binary missing; should not happen with bundled install; run /doctor).")).toBeTruthy();
  });

  it("renders local runtime details and loaded local models", async () => {
    renderProvidersSection();

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

    const view = renderProvidersSection();
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

    renderProvidersSection();

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

    renderProvidersSection();

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

    renderProvidersSection();

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

  it("renders the Coding Agents section and the OpenCode group with the Moonshot key row", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));

    renderProvidersSection();

    expect(await screen.findByText("Coding Agents")).toBeTruthy();
    expect(screen.getByText("OpenCode — Universal Model Access")).toBeTruthy();
    expect(screen.getByText("API Provider Keys")).toBeTruthy();
    // Moonshot AI was added to the API key grid.
    expect(screen.getByText("Moonshot AI")).toBeTruthy();
    expect(screen.getByText("MOONSHOT_API_KEY")).toBeTruthy();
    // Kimi for Coding is always surfaced as a subscription/membership row.
    expect(screen.getByLabelText("Connect Kimi for Coding")).toBeTruthy();
  });

  it("collapses the OpenCode group to an install card when the binary is missing", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { opencodeBinaryInstalled: false }));

    renderProvidersSection();

    expect(await screen.findByText("npm i -g opencode-ai")).toBeTruthy();
    expect(screen.getByText("brew install anomalyco/tap/opencode")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Re-check/ })).toBeTruthy();
    // The group body (API keys, subscriptions) must be hidden while uninstalled.
    expect(screen.queryByText("API Provider Keys")).toBeNull();
  });

  it("renders subscription connect rows and keeps chips visible while the provider catalog is stale", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      opencodeProvidersStale: true,
      opencodeProviders: [
        { id: "openai", name: "OpenAI", connected: false, modelCount: 12 },
        { id: "fireworks", name: "Fireworks", connected: false, modelCount: 7 },
      ],
    }));
    const authMethodsMock = window.ade.ai.opencodeAuthMethods as ReturnType<typeof vi.fn>;
    authMethodsMock.mockReset();
    authMethodsMock.mockResolvedValue({
      methods: {
        openai: [{ type: "oauth", label: "Sign in with ChatGPT" }],
      },
    });

    renderProvidersSection();

    // OAuth subscription row built dynamically from auth methods.
    expect(await screen.findByLabelText("Connect OpenAI")).toBeTruthy();
    // Stale label surfaces without blocking the catalog chips.
    expect(screen.getByText("updating…")).toBeTruthy();
    // Fireworks is not an API_KEY_PROVIDER, so it appears as a "More providers" chip.
    expect(screen.getByText(/Fireworks/)).toBeTruthy();
  });

  it("keeps an OpenCode key editor open when provider registration fails", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));
    const setProviderKeyMock = window.ade.ai.setOpencodeProviderKey as ReturnType<typeof vi.fn>;
    setProviderKeyMock.mockResolvedValue({ ok: false, error: "OpenCode rejected this key." });

    renderProvidersSection();

    const addButton = await screen.findByLabelText("Add OpenAI key");
    await act(async () => {
      addButton.click();
    });
    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: "sk-test" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });

    expect(await screen.findByText("OpenCode rejected this key.")).toBeTruthy();
    expect(setProviderKeyMock).toHaveBeenCalledWith({ providerId: "openai", key: "sk-test" });
    expect(window.ade.ai.storeApiKey).not.toHaveBeenCalled();
    expect(screen.getByLabelText("OpenAI API key")).toBeTruthy();
    expect(screen.queryByText("openai key saved.")).toBeNull();
  });

  it("clears an OpenCode provider credential before deleting its stored key", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock.mockResolvedValue(["openai"]);

    renderProvidersSection();

    const menuButton = await screen.findByLabelText("More actions for OpenAI");
    await act(async () => {
      menuButton.click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });

    await waitFor(() => {
      expect(window.ade.ai.clearOpencodeProviderKey).toHaveBeenCalledWith({ providerId: "openai" });
      expect(window.ade.ai.deleteApiKey).toHaveBeenCalledWith("openai");
    });
    const clearCall = (window.ade.ai.clearOpencodeProviderKey as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const deleteCall = (window.ade.ai.deleteApiKey as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(clearCall).toBeLessThan(deleteCall);
    expect(await screen.findByText("openai key removed.")).toBeTruthy();
  });

  it("drives the OAuth connect modal happy path", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      opencodeProviders: [{ id: "openai", name: "OpenAI", connected: false, modelCount: 12 }],
    }));
    const authMethodsMock = window.ade.ai.opencodeAuthMethods as ReturnType<typeof vi.fn>;
    authMethodsMock.mockReset();
    authMethodsMock.mockResolvedValue({
      methods: {
        openai: [{ type: "oauth", label: "Sign in with ChatGPT" }],
      },
    });

    renderProvidersSection();

    const connectButton = await screen.findByLabelText("Connect OpenAI");
    await act(async () => {
      connectButton.click();
    });

    // Modal opened.
    expect(screen.getByRole("dialog", { name: "Connect OpenAI" })).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });

    await waitFor(() => {
      expect(window.ade.ai.opencodeOAuthStart).toHaveBeenCalledWith({
        providerId: "openai",
        methodIndex: 0,
        inputs: undefined,
      });
      expect(window.ade.builtInBrowser.navigate).toHaveBeenCalledWith({
        url: "https://auth.openai.com/device",
        newTab: true,
      });
    });

    // Waiting state renders the extracted device code.
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();

    // Backend reports success → modal closes.
    await act(async () => {
      emitOAuthStatus?.({ providerId: "openai", state: "connected" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Connect OpenAI" })).toBeNull();
    });
  });
  // @cursor/sdk has no win32-arm64 build, so the Cursor card must be absent on
  // Windows on ARM rather than present and permanently unconnectable.
  // See apps/desktop/src/shared/providerPlatformSupport.ts.
  describe("Cursor card platform gating", () => {
    function setRuntimeTarget(platform: string, arch: string) {
      const ade = window.ade as unknown as { app?: Record<string, unknown> };
      ade.app = { ...(ade.app ?? {}), runtimeTarget: { platform, arch } };
    }

    it("hides the Cursor card on Windows on ARM", async () => {
      setRuntimeTarget("win32", "arm64");
      const view = renderProvidersSection();
      const current = within(view.container);

      await waitFor(() => {
        expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      });

      expect(current.queryByText("Uses CURSOR_API_KEY.")).toBeNull();
      expect(current.queryByLabelText("Add Cursor API key")).toBeNull();
      expect(current.queryByLabelText("Verify Cursor API key")).toBeNull();
      // The other providers are untouched.
      expect((await current.findAllByText("Claude Code")).length).toBeGreaterThan(0);
      expect(current.getAllByText("Codex CLI").length).toBeGreaterThan(0);
      expect(current.getAllByText("Droid").length).toBeGreaterThan(0);
    });

    it("keeps the Cursor card on Windows x64 and on macOS", async () => {
      for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"]] as const) {
        const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
        getStatusMock.mockReset();
        getStatusMock.mockResolvedValue(buildStatus(true));
        setRuntimeTarget(platform, arch);
        const view = renderProvidersSection();
        const current = within(view.container);

        expect(
          (await current.findAllByText("Uses CURSOR_API_KEY.")).length,
          `${platform}-${arch}`,
        ).toBeGreaterThan(0);
        expect(current.queryByLabelText("Add Cursor API key"), `${platform}-${arch}`).toBeTruthy();
        cleanup();
      }
    });
  });
});
