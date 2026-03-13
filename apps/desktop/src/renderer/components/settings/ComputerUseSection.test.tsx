/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseSettingsSnapshot } from "../../../shared/types";
import { ComputerUseSection } from "./ComputerUseSection";

function createSnapshot(): ComputerUseSettingsSnapshot {
  return {
    backendStatus: {
      backends: [
        {
          name: "Ghost OS",
          style: "external_mcp",
          available: true,
          state: "connected",
          detail: "Connected MCP backend with 8 tool(s).",
          supportedKinds: ["screenshot", "browser_trace", "browser_verification"],
        },
        {
          name: "agent-browser",
          style: "external_cli",
          available: false,
          state: "missing",
          detail: "agent-browser CLI is not installed on this machine.",
          supportedKinds: ["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"],
        },
      ],
      localFallback: {
        available: true,
        detail: "ADE local computer-use tools are available as a fallback.",
        supportedKinds: ["screenshot"],
      },
    },
    preferredBackend: "Ghost OS",
    capabilityMatrix: [
      {
        kind: "screenshot",
        externalBackends: ["Ghost OS", "agent-browser"],
        localFallbackAvailable: true,
      },
      {
        kind: "browser_trace",
        externalBackends: ["Ghost OS", "agent-browser"],
        localFallbackAvailable: false,
      },
    ],
    guidance: {
      overview: "External tools perform computer use. ADE manages proof artifacts and routing.",
      ghostOs: "Ghost OS connects through External MCP.",
      agentBrowser: "agent-browser is a CLI backend, not an MCP server.",
      fallback: "Local computer-use remains fallback-only.",
    },
  };
}

describe("ComputerUseSection", () => {
  beforeEach(() => {
    (window as any).ade = {
      computerUse: {
        getSettings: vi.fn(async () => createSnapshot()),
      },
      app: {
        openExternal: vi.fn(async () => {}),
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("renders readiness guidance for external-first computer use", async () => {
    const onOpenExternalMcp = vi.fn();
    render(<ComputerUseSection onOpenExternalMcp={onOpenExternalMcp} />);

    expect(await screen.findByText("ADE is the proof and artifact control plane.")).toBeTruthy();
    expect(screen.getByText("Ghost OS (External MCP)")).toBeTruthy();
    expect(screen.getByText("agent-browser (External CLI)")).toBeTruthy();
    expect(screen.getByText("ADE Local Fallback")).toBeTruthy();
    expect(screen.getAllByText("Ghost OS, agent-browser")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Open External MCP/i }));
    expect(onOpenExternalMcp).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect((window as any).ade.computerUse.getSettings).toHaveBeenCalledTimes(1);
    });
  });
});
