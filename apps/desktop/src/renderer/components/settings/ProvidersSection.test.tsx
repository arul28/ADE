/* @vitest-environment jsdom */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersSection } from "./ProvidersSection";
import type { AgentChatEventEnvelope, AiSettingsStatus } from "../../../shared/types";

function buildStatus(claudeRuntimeAvailable: boolean): AiSettingsStatus {
  return {
    mode: "subscription",
    availableProviders: {
      claude: claudeRuntimeAvailable,
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
    detectedAuth: [],
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
        blocker: "No Cursor CLI (`agent`) or Cursor credentials were found locally.",
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
          .mockResolvedValueOnce(buildStatus(true))
          .mockResolvedValueOnce(buildStatus(false)),
        listApiKeys: vi.fn().mockResolvedValue([]),
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
    globalThis.window.ade = originalAde;
  });

  it("refreshes provider status after an auth-related chat failure", async () => {
    render(<ProvidersSection />);
    const ade = window.ade as any;

    await waitFor(() => {
      expect(ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect((await screen.findAllByText("/Users/arul/.local/bin/claude")).length).toBeGreaterThan(0);

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
    expect(screen.getAllByText("/Users/arul/.local/bin/claude").length).toBeGreaterThan(0);
  });

  it("shows Connected while the provider runtime is launchable", async () => {
    render(<ProvidersSection />);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(1);
      expect(window.ade.ai.listApiKeys).toHaveBeenCalledTimes(1);
    });

    expect((await screen.findAllByText("Connected")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("/Users/arul/.local/bin/claude").length).toBeGreaterThan(0);
  });
});
