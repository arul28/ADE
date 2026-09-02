/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersSection } from "./ProvidersSection";
import type { AgentChatEventEnvelope, AiSettingsStatus, CursorSdkAuthEvent, PiAuthStatusEvent } from "../../../shared/types";

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
    Github: brand(),
    GithubCopilot: brand(),
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    Kimi: brand(),
    LmStudio: brand(),
    Ollama: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    Qwen: brand(),
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
    piInstallation?: AiSettingsStatus["piInstallation"];
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
      ...(options?.piInstallation ? {
        pi: {
          provider: "pi",
          authAvailable: options.piInstallation.providers.some((provider) => provider.configured),
          runtimeDetected: options.piInstallation.sdkAvailable || options.piInstallation.cliAvailable,
          runtimeAvailable: options.piInstallation.availableModelIds.length > 0,
          usageAvailable: false,
          path: options.piInstallation.cliPath ?? options.piInstallation.packageRoot,
          blocker: options.piInstallation.blocker,
          lastCheckedAt: "2026-03-17T19:00:00.000Z",
          sources: [],
        },
      } : {}),
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
    ...(options?.piInstallation ? { piInstallation: options.piInstallation } : {}),
  } as AiSettingsStatus;
}

function buildPiInstallation(): NonNullable<AiSettingsStatus["piInstallation"]> {
  return {
    installed: true,
    sdkAvailable: true,
    cliAvailable: true,
    cliPath: "/Users/example/.local/bin/pi",
    packageRoot: "/Users/example/.pi/agent/node_modules/@earendil-works/pi-coding-agent",
    version: "0.84.0",
    agentDir: "/Users/example/.pi/agent",
    settingsPath: "/Users/example/.pi/agent/settings.json",
    authPath: "/Users/example/.pi/agent/auth.json",
    modelsPath: "/Users/example/.pi/agent/models.json",
    modelsStorePath: "/Users/example/.pi/agent/models-store.json",
    blocker: null,
    providers: [
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        modelCount: 7,
        availableModelCount: 7,
        configured: true,
        authType: "oauth",
        authMethods: ["oauth"],
        authSource: "stored",
        authLabel: "OAuth",
        subscription: true,
      },
    ],
    availableModelIds: ["pi/default/openai-codex/gpt-5.4", "pi/default/openai-codex/gpt-5.4-codex"],
    authFileDetected: true,
    modelsFileDetected: false,
    settingsFileDetected: true,
    stale: false,
  };
}

/**
 * Settings → Agents & Models is a grid of providers plus one page per provider.
 * Passing an id renders that provider's page directly, which is what a
 * `?provider=<id>` deeplink does; passing nothing renders the grid.
 */
function renderProvidersSection(providerId: string | null = null) {
  return render(
    <MemoryRouter>
      <ProvidersSection providerParam={providerId} />
    </MemoryRouter>,
  );
}

describe("ProvidersSection", () => {
  const originalAde = globalThis.window.ade;
  let emitChatEvent: ((envelope: AgentChatEventEnvelope) => void) | null = null;
  let emitOAuthStatus: ((event: { providerId: string; state: string; error?: string }) => void) | null = null;
  let emitPiAuthStatus: ((event: PiAuthStatusEvent) => void) | null = null;
  let emitCursorAuthStatus: ((event: CursorSdkAuthEvent) => void) | null = null;

  beforeEach(() => {
    emitChatEvent = null;
    emitOAuthStatus = null;
    emitPiAuthStatus = null;
    emitCursorAuthStatus = null;

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
        piLoginProviders: vi.fn().mockResolvedValue([]),
        piLoginStart: vi.fn().mockResolvedValue({ ok: true }),
        piLoginSubmit: vi.fn().mockResolvedValue({ ok: true }),
        piLoginCancel: vi.fn().mockResolvedValue(undefined),
        onPiAuthStatus: vi.fn((cb: (event: PiAuthStatusEvent) => void) => {
          emitPiAuthStatus = cb;
          return () => {
            if (emitPiAuthStatus === cb) emitPiAuthStatus = null;
          };
        }),
        cursorAuthStatus: vi.fn().mockResolvedValue({
          sdkStatus: "logged-out",
          adeKeyPresent: false,
          loginInProgress: false,
        }),
        cursorAuthLogin: vi.fn().mockResolvedValue({ ok: true, email: "ada@cursor.com" }),
        cursorAuthLogout: vi.fn().mockResolvedValue({ ok: true }),
        cursorAuthCancel: vi.fn().mockResolvedValue(undefined),
        onCursorAuthStatus: vi.fn((cb: (event: CursorSdkAuthEvent) => void) => {
          emitCursorAuthStatus = cb;
          return () => {
            if (emitCursorAuthStatus === cb) emitCursorAuthStatus = null;
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
      app: {
        openExternal: vi.fn().mockResolvedValue(undefined),
        openPath: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("refreshes provider status after an auth-related chat failure", async () => {
    renderProvidersSection("claude");
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

    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(screen.getByText("Sign in to use Claude")).toBeTruthy();
    expect(screen.getAllByText("/Users/arul/ADE/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude").length).toBeGreaterThan(0);
  });

  it("shows Connected while the bundled Claude runtime is authenticated", async () => {
    renderProvidersSection("claude");

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect((await screen.findAllByText("Connected")).length).toBeGreaterThan(0);
    expect(screen.getByText("Uses your claude login — Claude Pro/Max subscription or ANTHROPIC_API_KEY.")).toBeTruthy();
    expect(screen.getAllByText("/Users/arul/ADE/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude").length).toBeGreaterThan(0);
  });

  it("shows Not installed when the Claude SDK native binary is unavailable", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(false, [], {
      claudeBinaryPresent: false,
      claudeAuthReady: false,
    }));

    renderProvidersSection("claude");

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText("Not installed")).toBeTruthy();
    expect(screen.getAllByText("Claude unavailable (binary missing; should not happen with bundled install; run /doctor).").length).toBeGreaterThan(0);
  });

  it("renders local runtime details and loaded local models", async () => {
    renderProvidersSection("opencode");

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

    const view = renderProvidersSection("opencode");
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

    renderProvidersSection("cursor");

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

    renderProvidersSection("cursor");

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
    // The grid has exactly six status words; a failed verify is one of them,
    // not a seventh phrase invented by the Cursor descriptor.
    expect(screen.getByText("Needs attention")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Dismiss error message").click();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("presents Cursor Sign in and API key as equal peers", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));

    renderProvidersSection("cursor");

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText("Sign in with Cursor or use a Cursor API key.")).toBeTruthy();
    expect(screen.getByLabelText("Sign in with Cursor")).toBeTruthy();
    expect(screen.getByLabelText("Add Cursor API key")).toBeTruthy();
    expect(screen.queryByLabelText("Sign out of Cursor")).toBeNull();
  });

  it("does not say Sign in required on the Cursor tile when Cursor OAuth is already logged in", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    const status = buildStatus(true, []);
    const connections = status.providerConnections;
    if (!connections) {
      throw new Error("expected providerConnections on Cursor status");
    }
    getStatusMock.mockResolvedValue({
      ...status,
      availableProviders: { ...status.availableProviders, cursor: false },
      providerConnections: {
        ...connections,
        cursor: {
          provider: "cursor",
          authAvailable: true,
          runtimeDetected: true,
          runtimeAvailable: false,
          usageAvailable: false,
          path: "@cursor/sdk",
          blocker: "Verify the Cursor API key to enable Cursor chat.",
          lastCheckedAt: "2026-03-17T19:00:00.000Z",
          accountEmail: "ada@cursor.com",
          sources: [
            {
              kind: "local-credentials",
              detected: true,
              source: "cursor-oauth",
            },
          ],
        },
      },
    });
    const cursorAuthStatus = window.ade.ai.cursorAuthStatus as ReturnType<typeof vi.fn>;
    cursorAuthStatus.mockResolvedValue({
      sdkStatus: "logged-in",
      email: "ada@cursor.com",
      adeKeyPresent: false,
      credentialSource: "cursor-oauth",
      loginInProgress: false,
    });

    renderProvidersSection();

    const tile = await screen.findByLabelText("Open Cursor settings");
    expect(await within(tile).findByText("Needs attention")).toBeTruthy();
    expect(within(tile).queryByText("Sign in required")).toBeNull();
    expect(within(tile).getByText("Verify the Cursor API key to enable Cursor chat.")).toBeTruthy();
  });

  it("signs in with Cursor, shows the login URL while pending, then signs out", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    const loggedOut = buildStatus(true, []);
    const loggedOutConnections = loggedOut.providerConnections;
    if (!loggedOutConnections) {
      throw new Error("expected providerConnections on logged-out Cursor status");
    }
    const loggedIn: AiSettingsStatus = {
      ...loggedOut,
      availableProviders: { ...loggedOut.availableProviders, cursor: true },
      providerConnections: {
        ...loggedOutConnections,
        cursor: {
          provider: "cursor",
          authAvailable: true,
          runtimeDetected: true,
          runtimeAvailable: true,
          usageAvailable: false,
          path: "@cursor/sdk",
          blocker: null,
          lastCheckedAt: "2026-03-17T19:00:00.000Z",
          accountEmail: "ada@cursor.com",
          sources: [
            {
              kind: "local-credentials",
              detected: true,
              source: "cursor-oauth",
            },
          ],
        },
      },
    };
    getStatusMock.mockResolvedValue(loggedOut);

    let resolveLogin: ((value: { ok: true; email: string }) => void) | null = null;
    const cursorAuthLogin = window.ade.ai.cursorAuthLogin as ReturnType<typeof vi.fn>;
    cursorAuthLogin.mockImplementation(
      () => new Promise<{ ok: true; email: string }>((resolve) => {
        resolveLogin = resolve;
      }),
    );
    const cursorAuthStatus = window.ade.ai.cursorAuthStatus as ReturnType<typeof vi.fn>;
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;

    renderProvidersSection("cursor");

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      screen.getByLabelText("Sign in with Cursor").click();
    });

    act(() => {
      emitCursorAuthStatus?.({
        providerId: "cursor",
        state: "pending",
        url: "https://cursor.com/loginDeepControl?uuid=abc",
      });
    });

    expect(await screen.findByText("https://cursor.com/loginDeepControl?uuid=abc")).toBeTruthy();
    expect(screen.getByLabelText("Cancel Cursor sign-in")).toBeTruthy();

    getStatusMock.mockResolvedValue(loggedIn);
    listApiKeysMock.mockResolvedValue(["cursor"]);
    cursorAuthStatus.mockResolvedValue({
      sdkStatus: "logged-in",
      email: "ada@cursor.com",
      adeKeyPresent: true,
      credentialSource: "cursor-oauth",
      loginInProgress: false,
    });

    await act(async () => {
      resolveLogin?.({ ok: true, email: "ada@cursor.com" });
    });

    await waitFor(() => {
      expect(window.ade.ai.cursorAuthLogin).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.verifyApiKey).toHaveBeenCalledWith("cursor");
    });
    expect(await screen.findByText("Signed in as ada@cursor.com")).toBeTruthy();
    expect(screen.getByLabelText("Sign out of Cursor")).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Sign out of Cursor").click();
    });

    await waitFor(() => {
      expect(window.ade.ai.cursorAuthLogout).toHaveBeenCalledTimes(1);
    });
  });

  it("forces a provider status refresh after verifying a stored Cursor API key", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock.mockResolvedValue(["cursor"]);

    renderProvidersSection("cursor");

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

  it("renders one labelled tile per provider on the grid", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));

    renderProvidersSection();

    for (const label of ["Claude Code", "Codex CLI", "Cursor", "Droid", "Pi", "OpenCode"]) {
      expect(await screen.findByLabelText(`Open ${label} settings`), label).toBeTruthy();
    }
    // Status is a word, not a colour: every tile says which of the six it is.
    expect(screen.getAllByText(/^(Connected|Sign in required|Needs attention|Not installed|Checking…|Disabled)$/).length)
      .toBeGreaterThan(0);
    // The catalogs are behind their provider, not spilled onto the grid.
    expect(screen.queryByLabelText("Search all OpenCode providers")).toBeNull();
  });

  // "GitHub Copilot" is the longest name on the grid, and it used to render as
  // "GitHub Co…" because the logo, the name, the Preview chip, and an uppercase
  // letterspaced status chip all shared one 280px row. The fix has to hold at
  // the markup level: whatever else the tile clips, it is not the name.
  it("does not clip a long provider name on its tile", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));

    renderProvidersSection();

    const tile = await screen.findByLabelText("Open GitHub Copilot settings");
    const name = within(tile).getByTestId("provider-tile-name-copilot");
    expect(name.textContent).toBe("GitHub Copilot");
    expect(name.style.textOverflow).toBe("");
    expect(name.style.whiteSpace).toBe("");
  });

  // A status probe that has not answered is not the same claim as "this is not
  // installed", and the grid has to say so while the first probe is out.
  it("says Checking on every tile until the first status lands", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockImplementation(() => new Promise(() => undefined));

    renderProvidersSection();

    expect((await screen.findAllByText("Checking…")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Not installed")).toBeNull();
  });

  it("does not leave Qwen on Checking after the first status probe fails", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockRejectedValue(
      new Error("Remote ADE service timed out waiting for method ade/actions/call (30000ms)."),
    );

    renderProvidersSection();

    const tile = await screen.findByLabelText("Open Qwen Code settings");
    expect(await within(tile).findByText("Needs attention")).toBeTruthy();
    expect(within(tile).queryByText("Checking…")).toBeNull();
    expect(screen.queryByText("Not installed")).toBeNull();
  });

  it("renders the OpenCode catalog on the OpenCode page", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));

    renderProvidersSection("opencode");

    expect(await screen.findByText(/^All providers · \d+$/)).toBeTruthy();
    expect(screen.getByLabelText("Search all OpenCode providers")).toBeTruthy();
    // Popular cards include Moonshot and Kimi.
    expect(screen.getByText("Moonshot AI")).toBeTruthy();
    expect(screen.getByLabelText("Connect Kimi for Coding")).toBeTruthy();
    // Hated status chrome is gone.
    expect(screen.queryByText(/managed by ADE/i)).toBeNull();
    expect(screen.queryByText(/subscriptions ·/i)).toBeNull();
  });

  /** Open a Pi provider's card, then return its sign-in button from the dialog. */
  async function openPiProviderSignIn(providerName: string, buttonName: string): Promise<HTMLElement> {
    const tile = await screen.findByRole("button", {
      name: new RegExp(`^(?:Open|Connect) ${providerName} in Pi$`),
    });
    await act(async () => {
      tile.click();
    });
    return await screen.findByRole("button", { name: buttonName });
  }

  it("renders the Pi card with connected providers and opens Pi settings files", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock.mockResolvedValue([]);

    renderProvidersSection("pi");

    expect(await screen.findByText("Pi")).toBeTruthy();
    expect(screen.getByText(/Uses Pi’s installed SDK package/)).toBeTruthy();
    expect(screen.getByText(/Version 0.84.0/)).toBeTruthy();
    expect(screen.getByText("OpenAI Codex")).toBeTruthy();
    expect(screen.getByText(/7 models/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open settings.json" })).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Open settings.json" }).click();
    });
    expect(window.ade.app.openPath).toHaveBeenCalledWith("/Users/example/.pi/agent/settings.json");
  });

  it("signs into a Pi provider in-app: device code, prompt, then success", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock.mockResolvedValue([]);
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth", "api_key"], configured: false, loginLabel: "Sign in with SuperGrok" },
    ]);
    let resolveLogin: ((result: { ok: boolean; error?: string }) => void) | null = null;
    (window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; error?: string }>((resolve) => {
        resolveLogin = resolve;
      }),
    );

    renderProvidersSection("pi");

    const signIn = await openPiProviderSignIn("xAI", "Sign in with SuperGrok — xAI");
    expect(screen.getByRole("button", { name: "Use an API key — xAI" })).toBeTruthy();

    await act(async () => {
      signIn.click();
    });
    expect(window.ade.ai.piLoginStart).toHaveBeenCalledWith({ providerId: "xai", method: "oauth" });

    await act(async () => {
      emitPiAuthStatus?.({
        providerId: "xai",
        state: "pending",
        notice: { level: "info", message: "Enter the code", userCode: "ABCD-1234", verificationUri: "https://x.ai/device" },
      });
    });
    expect(screen.getByText("ABCD-1234")).toBeTruthy();

    await act(async () => {
      emitPiAuthStatus?.({
        providerId: "xai",
        state: "prompt",
        prompt: { requestId: "req-1", kind: "manual_code", title: "Sign in to xAI", message: "Paste the code from your browser" },
      });
    });
    const input = screen.getByLabelText("Paste the code from your browser") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "code-42" } });
    await act(async () => {
      screen.getByRole("button", { name: "Continue" }).click();
    });
    expect(window.ade.ai.piLoginSubmit).toHaveBeenCalledWith({
      providerId: "xai",
      requestId: "req-1",
      value: "code-42",
    });

    await act(async () => {
      resolveLogin?.({ ok: true });
    });
    expect(screen.getByText(/Signed in to xAI\./)).toBeTruthy();
  });

  it("surfaces a rejected Pi prompt answer instead of waiting out the login timeout", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
    ]);
    // The login promise never settles here: only the submit result can tell the
    // user their answer was rejected.
    (window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; error?: string }>(() => undefined),
    );
    (window.ade.ai.piLoginSubmit as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "That prompt has already been answered.",
    });

    renderProvidersSection("pi");

    const signIn = await openPiProviderSignIn("xAI", "Sign in — xAI");
    await act(async () => {
      signIn.click();
    });
    await act(async () => {
      emitPiAuthStatus?.({
        providerId: "xai",
        state: "prompt",
        prompt: { requestId: "req-1", kind: "manual_code", title: "Sign in to xAI", message: "Paste the code from your browser" },
      });
    });

    const input = screen.getByLabelText("Paste the code from your browser") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "code-42" } });
    await act(async () => {
      screen.getByRole("button", { name: "Continue" }).click();
    });

    const failure = await screen.findByText(/xAI: That prompt has already been answered\./);
    expect(failure.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("offers a retry when a Pi sign-in fails", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false, loginLabel: "Sign in with SuperGrok" },
    ]);
    const startMock = window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>;
    startMock.mockResolvedValue({ ok: false, error: "Device code expired." });

    renderProvidersSection("pi");

    const signIn = await openPiProviderSignIn("xAI", "Sign in with SuperGrok — xAI");
    await act(async () => {
      signIn.click();
    });
    expect(screen.getByText(/xAI: Device code expired\./)).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(startMock).toHaveBeenLastCalledWith({ providerId: "xai", method: "oauth" });
  });

  it("treats a cancelled Pi sign-in as a choice, not a failure", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
    ]);
    let resolveLogin: ((result: { ok: boolean; error?: string }) => void) | null = null;
    (window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; error?: string }>((resolve) => {
        resolveLogin = resolve;
      }),
    );

    renderProvidersSection("pi");

    const signIn = await openPiProviderSignIn("xAI", "Sign in — xAI");
    await act(async () => {
      signIn.click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });
    await act(async () => {
      resolveLogin?.({ ok: false, error: "Sign-in cancelled." });
    });

    const cancelled = screen.getByText("Sign-in cancelled.");
    expect(cancelled.closest('[role="status"]')).toBeTruthy();
    expect(cancelled.closest('[role="alert"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("merges a configured provider and its sign-in options into one tile", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "openai-codex", name: "OpenAI Codex", authTypes: ["oauth"], configured: true },
    ]);

    renderProvidersSection("pi");

    expect((await screen.findAllByText("OpenAI Codex")).length).toBe(1);
    expect(screen.getByText(/7 models/)).toBeTruthy();
    expect(await openPiProviderSignIn("OpenAI Codex", "Sign in — OpenAI Codex")).toBeTruthy();
  });

  // Settings is torn down by any navigation, so cancelling on unmount killed
  // the login of anyone who switched away while authorizing in their browser.
  it("leaves a Pi sign-in running when Settings unmounts", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
    ]);
    (window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; error?: string }>(() => undefined),
    );

    const view = renderProvidersSection("pi");
    const signIn = await openPiProviderSignIn("xAI", "Sign in — xAI");
    await act(async () => {
      signIn.click();
    });

    await act(async () => {
      view.unmount();
    });
    expect(window.ade.ai.piLoginCancel).not.toHaveBeenCalled();
  });

  // The outcome is reported by the status event, not only by whoever is still
  // awaiting the start call, so a card that remounted mid-flow still learns.
  it("reports a Pi sign-in that completed while no start call was pending", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
    ]);

    renderProvidersSection("pi");
    await screen.findByRole("button", { name: "Connect xAI in Pi" });
    getStatusMock.mockClear();

    await act(async () => {
      emitPiAuthStatus?.({ providerId: "xai", state: "success" });
    });

    expect(screen.getByText(/Signed in to xAI\./)).toBeTruthy();
    expect(getStatusMock).toHaveBeenCalled();
  });

  // finish() emits the event and resolves the start call from the same place;
  // whichever lands first must settle, and the other must be a no-op.
  it("reports a Pi sign-in once when both the event and the call resolve", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
    ]);
    let resolveLogin: ((result: { ok: boolean; error?: string }) => void) | null = null;
    (window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; error?: string }>((resolve) => {
        resolveLogin = resolve;
      }),
    );

    renderProvidersSection("pi");
    const signIn = await openPiProviderSignIn("xAI", "Sign in — xAI");
    await act(async () => {
      signIn.click();
    });
    const loadCallsBefore = (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mock.calls.length;
    getStatusMock.mockClear();

    await act(async () => {
      emitPiAuthStatus?.({ providerId: "xai", state: "success" });
      resolveLogin?.({ ok: true });
    });

    expect(screen.getByText(/Signed in to xAI\./)).toBeTruthy();
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect((window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadCallsBefore + 1);
  });

  // The settle latch is per provider, so it has to be released when a new
  // attempt starts — otherwise the first outcome is the only one a provider
  // can ever report for the rest of the session.
  it("reports the outcome of a Pi sign-in restarted after a cancelled one", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
    ]);
    (window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; error?: string }>(() => undefined),
    );

    renderProvidersSection("pi");
    const signIn = await openPiProviderSignIn("xAI", "Sign in — xAI");
    await act(async () => {
      signIn.click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });
    // The service settles the cancel after its grace window.
    await act(async () => {
      emitPiAuthStatus?.({ providerId: "xai", state: "error", error: "Sign-in cancelled." });
    });
    expect(screen.getByText("Sign-in cancelled.")).toBeTruthy();

    const restarted = await openPiProviderSignIn("xAI", "Sign in — xAI");
    await act(async () => {
      restarted.click();
    });
    await act(async () => {
      emitPiAuthStatus?.({
        providerId: "xai",
        state: "prompt",
        prompt: { requestId: "req-2", kind: "manual_code", title: "Sign in to xAI", message: "Paste the code from your browser" },
      });
    });
    expect(screen.getByLabelText("Paste the code from your browser")).toBeTruthy();

    await act(async () => {
      emitPiAuthStatus?.({ providerId: "xai", state: "success" });
    });
    expect(screen.getByText(/Signed in to xAI\./)).toBeTruthy();
  });

  // Pi is already polling the grant by the time the URL arrives; making the
  // user find and press "Open" first is dead time in a timed flow.
  it("opens a Pi device-code URL without waiting for a click", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
    ]);
    (window.ade.ai.piLoginStart as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; error?: string }>(() => undefined),
    );

    renderProvidersSection("pi");
    const signIn = await openPiProviderSignIn("xAI", "Sign in — xAI");
    await act(async () => {
      signIn.click();
    });
    await act(async () => {
      emitPiAuthStatus?.({
        providerId: "xai",
        state: "pending",
        notice: { level: "info", message: "Enter the code", userCode: "ABCD-1234", verificationUri: "https://x.ai/device" },
      });
    });

    expect(window.ade.app.openExternal).toHaveBeenCalledWith("https://x.ai/device");
    // The code and a manual escape hatch stay on screen for a blocked browser.
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  // A localhost model server has no credential to collect, so asking for an
  // API key is the wrong question — it gets its own section and a reachability
  // report instead.
  it("reports Pi local model servers without offering an API key", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      piInstallation: {
        ...buildPiInstallation(),
        providers: [
          ...buildPiInstallation().providers,
          {
            id: "lmstudio",
            name: "LM Studio",
            modelCount: 2,
            availableModelCount: 2,
            configured: true,
            authType: "local",
            authMethods: ["local"],
            baseUrl: "http://127.0.0.1:1234/v1",
          },
        ],
      },
    }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderProvidersSection("pi");

    const localServers = await screen.findByRole("group", { name: "Pi local model servers" });
    expect(within(localServers).getByText("Local Model Servers")).toBeTruthy();
    // ADE's own probe is the authority on where the server is and whether it
    // answered; Pi's configured baseUrl is only the fallback.
    expect(within(localServers).getByText("http://localhost:1234")).toBeTruthy();
    expect(within(localServers).getByText("Not detected")).toBeTruthy();
    // Never a sign-in affordance for a server the user runs.
    expect(screen.queryByRole("button", { name: /LM Studio in Pi$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Use an API key — LM Studio/ })).toBeNull();
  });

  // ADE only probes ollama and lmstudio. A third loopback server is reported by
  // Pi's own profile and by nothing else, so a probe-shaped label left it
  // reading "Not checked" forever — a status that never resolves.
  it("falls back to Pi's profile for a local server ADE cannot probe", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      piInstallation: {
        ...buildPiInstallation(),
        providers: [
          ...buildPiInstallation().providers,
          {
            id: "llamacpp",
            name: "llama.cpp",
            modelCount: 1,
            availableModelCount: 1,
            configured: true,
            authType: "local",
            authMethods: ["local"],
            baseUrl: "http://127.0.0.1:8080/v1",
          },
        ],
      },
    }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderProvidersSection("pi");

    const localServers = await screen.findByRole("group", { name: "Pi local model servers" });
    expect(within(localServers).getByText("llama.cpp")).toBeTruthy();
    expect(within(localServers).getByText("Configured in Pi")).toBeTruthy();
    expect(within(localServers).queryByText("Not checked")).toBeNull();
    // Still a server the user runs: no credential affordance.
    expect(screen.queryByRole("button", { name: /llama\.cpp in Pi$/ })).toBeNull();
  });

  // Everything the local-servers section shows comes from the AI status probe,
  // not from Pi's login list, so refreshing only the latter left the button
  // spinning over data that could not change.
  it("re-probes local servers when Pi's Refresh is pressed", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      piInstallation: {
        ...buildPiInstallation(),
        providers: [
          ...buildPiInstallation().providers,
          {
            id: "lmstudio",
            name: "LM Studio",
            modelCount: 1,
            availableModelCount: 1,
            configured: true,
            authType: "local",
            authMethods: ["local"],
            baseUrl: "http://127.0.0.1:1234/v1",
          },
        ],
      },
    }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderProvidersSection("pi");
    const localServers = await screen.findByRole("group", { name: "Pi local model servers" });
    getStatusMock.mockClear();

    await act(async () => {
      within(localServers).getByRole("button", { name: /Refresh/ }).click();
    });

    expect(getStatusMock).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("filters Pi providers with the search box", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { piInstallation: buildPiInstallation() }));
    (window.ade.ai.piLoginProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: false },
      { id: "groq", name: "Groq", authTypes: ["api_key"], configured: false },
    ]);

    renderProvidersSection("pi");

    const search = await screen.findByLabelText("Search all Pi providers");
    expect(screen.getByRole("button", { name: "Connect Groq in Pi" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "xa" } });
    expect(screen.getByRole("button", { name: "Connect xAI in Pi" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Groq in Pi" })).toBeNull();
  });

  it("explains the Pi card instead of stranding it when Pi's SDK is missing", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      piInstallation: {
        ...buildPiInstallation(),
        sdkAvailable: false,
        providers: [],
        availableModelIds: [],
        blocker: "Pi is installed, but ADE cannot load its package here.",
      },
    }));

    renderProvidersSection("pi");

    expect((await screen.findAllByText("Pi is installed, but ADE cannot load its package here.")).length).toBe(1);
    // ADE used to offer to open Pi and type `/login` into its TUI after a fixed
    // delay. That raced Pi's startup and submitted empty lines, so the branch
    // states the instruction rather than automating it.
    expect(screen.queryByRole("button", { name: /Open Pi \/login/ })).toBeNull();
    expect(screen.getByText(/run pi in a terminal and use its \/login command/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refresh providers/ })).toBeNull();
    expect(window.ade.ai.piLoginProviders).not.toHaveBeenCalled();
  });

  it("collapses the OpenCode group to an install card when the binary is missing", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], { opencodeBinaryInstalled: false }));

    renderProvidersSection("opencode");

    expect(await screen.findByText("npm i -g opencode-ai")).toBeTruthy();
    expect(screen.getByText("brew install anomalyco/tap/opencode")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Re-check/ })).toBeTruthy();
    // The group body is hidden while uninstalled.
    expect(screen.queryByText(/^All providers/)).toBeNull();
  });

  it("renders provider cards and catalog-updating state while inventory is stale", async () => {
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

    renderProvidersSection("opencode");

    expect(await screen.findByLabelText("Connect OpenAI")).toBeTruthy();
    expect(screen.getByText(/Updating provider catalog/i)).toBeTruthy();
    // Search finds catalog-only providers.
    fireEvent.change(screen.getByLabelText("Search all OpenCode providers"), {
      target: { value: "Fireworks" },
    });
    expect(await screen.findByLabelText("Connect Fireworks")).toBeTruthy();
  });

  it("keeps local providers out of the OpenCode catalog merge", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      opencodeProviders: [
        { id: "cursor", name: "Cursor", connected: false, modelCount: 3 },
        { id: "ollama", name: "Ollama", connected: false, modelCount: 4 },
        { id: "lmstudio", name: "LM Studio", connected: false, modelCount: 5 },
        { id: "openai", name: "OpenAI", connected: false, modelCount: 12 },
      ],
    }));
    const authMethodsMock = window.ade.ai.opencodeAuthMethods as ReturnType<typeof vi.fn>;
    authMethodsMock.mockReset();
    authMethodsMock.mockResolvedValue({
      methods: {
        cursor: [{ type: "oauth", label: "Sign in with Cursor" }],
        ollama: [{ type: "api", label: "Ollama API" }],
        lmstudio: [{ type: "api", label: "LM Studio API" }],
        openai: [{ type: "oauth", label: "Sign in with ChatGPT" }],
      },
    });

    renderProvidersSection("opencode");

    expect(await screen.findByLabelText("Connect OpenAI")).toBeTruthy();
    expect(screen.queryByLabelText("Connect Cursor")).toBeNull();
    expect(screen.queryByLabelText("Connect Ollama")).toBeNull();
    expect(screen.queryByLabelText("Connect LM Studio")).toBeNull();
  });

  it("offers a retry when the initial OpenCode status probe fails", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockRejectedValue(new Error("status probe unavailable"));

    renderProvidersSection("opencode");

    expect(await screen.findByText("Could not load OpenCode status.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-check OpenCode" })).toBeTruthy();
    expect(screen.getAllByText("status probe unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it("keeps an auth-method outage out of an API-key-only provider", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      opencodeProviders: [{ id: "openai", name: "OpenAI", connected: false, modelCount: 12 }],
    }));
    const authMethodsMock = window.ade.ai.opencodeAuthMethods as ReturnType<typeof vi.fn>;
    authMethodsMock.mockReset();
    authMethodsMock.mockRejectedValue(new Error("catalog unavailable"));

    renderProvidersSection("opencode");

    await waitFor(() => {
      expect(authMethodsMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(await screen.findByLabelText("Connect OpenAI"));

    expect(screen.getByRole("dialog", { name: "OpenAI provider" })).toBeTruthy();
    expect(screen.getAllByText("API key").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Could not load OpenCode sign-in methods/)).toBeNull();
  });

  it("keeps an OpenCode key editor open when provider registration fails", async () => {
    const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
    getStatusMock.mockReset();
    getStatusMock.mockResolvedValue(buildStatus(true, []));
    const setProviderKeyMock = window.ade.ai.setOpencodeProviderKey as ReturnType<typeof vi.fn>;
    setProviderKeyMock.mockResolvedValue({ ok: false, error: "OpenCode rejected this key." });

    renderProvidersSection("opencode");

    const openAiCard = await screen.findByLabelText("Connect OpenAI");
    await act(async () => {
      openAiCard.click();
    });
    expect(screen.getByRole("dialog", { name: "OpenAI provider" })).toBeTruthy();

    await act(async () => {
      screen.getByLabelText("Add OpenAI key").click();
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
    getStatusMock.mockResolvedValue(buildStatus(true, [], {
      opencodeProviders: [{ id: "openai", name: "OpenAI", connected: true, modelCount: 12 }],
    }));
    const listApiKeysMock = window.ade.ai.listApiKeys as ReturnType<typeof vi.fn>;
    listApiKeysMock.mockReset();
    listApiKeysMock.mockResolvedValue(["openai"]);
    const authMethodsMock = window.ade.ai.opencodeAuthMethods as ReturnType<typeof vi.fn>;
    authMethodsMock.mockReset();
    authMethodsMock.mockRejectedValue(new Error("catalog unavailable"));

    renderProvidersSection("opencode");

    // Wait until stored keys hydrate so the card reflects key ownership.
    await waitFor(() => {
      expect(window.ade.ai.listApiKeys).toHaveBeenCalled();
    });
    const openCard = await screen.findByLabelText("Open OpenAI");
    await act(async () => {
      openCard!.click();
    });
    expect(screen.queryByText("Subscription / OAuth")).toBeNull();
    expect(screen.queryByText(/Could not load OpenCode sign-in methods/)).toBeNull();
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
    expect(await screen.findByText("OpenAI disconnected.")).toBeTruthy();
  });

  it("drives the OAuth connect modal happy path via provider detail", async () => {
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

    renderProvidersSection("opencode");

    const openAiCard = await screen.findByLabelText("Connect OpenAI");
    await act(async () => {
      openAiCard.click();
    });
    expect(screen.getByRole("dialog", { name: "OpenAI provider" })).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Sign in to OpenAI" }).click();
    });
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
      expect(window.ade.app.openExternal).toHaveBeenCalledWith("https://auth.openai.com/device");
    });

    // Waiting state renders the extracted device code.
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();

    // Backend reports success → oauth modal closes.
    await act(async () => {
      emitOAuthStatus?.({ providerId: "openai", state: "connected" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Connect OpenAI" })).toBeNull();
    });
  });
  // The four ACP providers plug into the same descriptor system as the six.
  // These pin the parts a copy-paste port would get wrong.
  describe("ACP providers", () => {
    it("gives each ACP provider a tile on the grid", async () => {
      const view = renderProvidersSection();
      const current = within(view.container);
      await waitFor(() => {
        expect(window.ade.ai.getStatus).toHaveBeenCalled();
      });
      for (const label of ["Qwen Code", "Kimi", "Grok", "GitHub Copilot"]) {
        expect(current.getByLabelText(`Open ${label} settings`), label).toBeTruthy();
      }
    });

    it("says Kimi hides the usage meter, in plain words, on its page", async () => {
      const view = renderProvidersSection("kimi");
      const current = within(view.container);
      expect(
        (await current.findAllByText("Kimi does not report token usage; the usage meter stays hidden.")).length,
      ).toBeGreaterThan(0);
      expect(current.getByText(/--region global/)).toBeTruthy();
      expect(current.getByText(/does not write that file/)).toBeTruthy();
    });

    it("says ADE reuses the Qwen CLI the user already set up", async () => {
      const view = renderProvidersSection("qwen");
      const current = within(view.container);
      expect(await current.findByText(/does not write ~\/.qwen/)).toBeTruthy();
      expect(current.getAllByText(/OPENAI_BASE_URL/).length).toBeGreaterThan(0);
    });

    // The chip is a claim about the models, so it must come from the registry's
    // `previewTier`, not from a hand-maintained list of provider names.
    it("marks only the preview-tier providers with a Preview chip", async () => {
      for (const [provider, expected] of [["grok", true], ["copilot", true], ["qwen", false], ["kimi", false]] as const) {
        const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
        getStatusMock.mockReset();
        getStatusMock.mockResolvedValue(buildStatus(true));
        const view = renderProvidersSection(provider);
        const current = within(view.container);
        await waitFor(() => {
          expect(getStatusMock).toHaveBeenCalled();
        });
        expect(current.queryAllByText("Preview").length > 0, provider).toBe(expected);
        cleanup();
      }
    });

    it("runs the vendor doctor only where one exists", async () => {
      const runDiagnostics = vi.fn().mockResolvedValue({
        provider: "grok",
        binaryPath: "/opt/homebrew/bin/grok",
        binarySource: "path",
        configHome: "/Users/ada/.grok",
        version: "1.0.14",
        versionError: null,
        lastProbe: null,
        doctor: { command: "grok doctor", exitCode: 0, output: "everything is fine" },
        checkedAt: "2026-08-31T00:00:00.000Z",
      });
      (window.ade as any).ai.acpProviderDiagnostics = runDiagnostics;

      const view = renderProvidersSection("grok");
      const current = within(view.container);
      const button = await current.findByRole("button", { name: "Run grok doctor" });
      await act(async () => {
        fireEvent.click(button);
      });
      await waitFor(() => {
        expect(current.getByText("everything is fine")).toBeTruthy();
      });
      expect(runDiagnostics).toHaveBeenCalledWith({ provider: "grok", runDoctor: true });

      cleanup();
      // Qwen ships no `doctor`, so offering the button would run the word as a
      // prompt.
      const qwenView = renderProvidersSection("qwen");
      await waitFor(() => {
        expect(window.ade.ai.getStatus).toHaveBeenCalled();
      });
      expect(within(qwenView.container).queryByRole("button", { name: /doctor/ })).toBeNull();
    });
  });

  describe("provider disable toggle", () => {
    it("writes the whole disabled list and keeps the page reachable", async () => {
      const view = renderProvidersSection("grok");
      const current = within(view.container);
      const disable = await current.findByRole("button", { name: "Disable Grok" });
      await act(async () => {
        fireEvent.click(disable);
      });
      expect(window.ade.ai.updateConfig).toHaveBeenCalledWith({ disabledProviders: ["grok"] });
    });

    it("shows Disabled on the tile and offers the way back on", async () => {
      (window.ade as any).projectConfig.get = vi.fn().mockResolvedValue({
        effective: { ai: { disabledProviders: ["grok"] } },
      });

      const grid = renderProvidersSection();
      await waitFor(() => {
        expect(window.ade.ai.getStatus).toHaveBeenCalled();
      });
      const tile = within(grid.container).getByLabelText("Open Grok settings");
      await waitFor(() => {
        expect(within(tile).getByText("Disabled")).toBeTruthy();
      });

      cleanup();
      const page = renderProvidersSection("grok");
      // The switch has to be findable from the page it turned off, or it is a
      // one-way door.
      expect(await within(page.container).findByRole("button", { name: "Enable Grok" })).toBeTruthy();
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

      expect(current.queryByLabelText("Open Cursor settings")).toBeNull();
      // The other providers are untouched.
      expect(await current.findByLabelText("Open Claude Code settings")).toBeTruthy();
      expect(current.getByLabelText("Open Codex CLI settings")).toBeTruthy();
      expect(current.getByLabelText("Open Droid settings")).toBeTruthy();
    });

    it("keeps the Cursor card on Windows x64 and on macOS", async () => {
      for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"]] as const) {
        const getStatusMock = window.ade.ai.getStatus as ReturnType<typeof vi.fn>;
        getStatusMock.mockReset();
        getStatusMock.mockResolvedValue(buildStatus(true));
        setRuntimeTarget(platform, arch);
        const view = renderProvidersSection("cursor");
        const current = within(view.container);

        expect(
          (await current.findAllByText("Sign in with Cursor or use a Cursor API key.")).length,
          `${platform}-${arch}`,
        ).toBeGreaterThan(0);
        expect(current.queryByLabelText("Add Cursor API key"), `${platform}-${arch}`).toBeTruthy();
        cleanup();
      }
    });
  });
});
