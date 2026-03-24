import type { ComputerUseBackendStatus, ExternalMcpServerSnapshot } from "../../../shared/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ai/utils", () => ({
  commandExists: vi.fn(() => true),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((command: string, args: string[]) => {
    if (command === "ghost" && args[0] === "doctor") {
      return {
        stdout: "[FAIL] Processes: 34 ghost MCP processes found (expect 0 or 1)\n",
        stderr: "",
        error: null,
      };
    }
    if (command === "ghost" && args[0] === "status") {
      return {
        stdout: "status: ready\n",
        stderr: "",
        error: null,
      };
    }
    return {
      stdout: "",
      stderr: "",
      error: null,
    };
  }),
}));

import { buildComputerUseOwnerSnapshot, buildComputerUseSettingsSnapshot } from "./controlPlane";

function createBackendStatus(): ComputerUseBackendStatus {
  return {
    backends: [
      {
        name: "Ghost OS",
        style: "external_mcp",
        available: true,
        state: "connected",
        detail: "Connected MCP backend with 12 tool(s).",
        supportedKinds: ["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"],
      },
    ],
    localFallback: {
      available: true,
      detail: "Fallback available.",
      supportedKinds: ["screenshot"],
    },
  };
}

function createGhostSnapshot(): ExternalMcpServerSnapshot {
  return {
    config: {
      name: "Ghost OS",
      transport: "stdio",
      command: "ghost",
      args: ["mcp"],
      env: {},
      cwd: "/tmp",
    },
    state: "connected",
    toolCount: 12,
    tools: [],
    lastConnectedAt: "2026-03-24T05:57:45.700Z",
    lastHealthCheckAt: "2026-03-24T05:57:45.700Z",
    consecutivePingFailures: 0,
    lastError: null,
    autoStart: true,
  };
}

describe("computer use control plane", () => {
  it("shows live backend activity when a backend is connected", () => {
    const snapshot = buildComputerUseOwnerSnapshot({
      broker: {
        getBackendStatus: vi.fn(() => createBackendStatus()),
        listArtifacts: vi.fn(() => []),
      } as any,
      owner: { kind: "chat_session", id: "chat-1" },
      policy: null,
    });

    expect(snapshot.summary).toContain("Ghost OS is connected and ready to capture proof");
    expect(snapshot.activity.some((item) => item.kind === "backend_connected")).toBe(true);
  });

  it("surfaces live external tool activity for the active chat before proof is ingested", () => {
    const snapshot = buildComputerUseOwnerSnapshot({
      broker: {
        getBackendStatus: vi.fn(() => createBackendStatus()),
        listArtifacts: vi.fn(() => []),
      } as any,
      owner: { kind: "chat_session", id: "chat-1" },
      policy: null,
      usageEvents: [
        {
          id: "usage-1",
          serverName: "Ghost OS",
          toolName: "ghost_click",
          namespacedToolName: "ext.ghost-os.ghost_click",
          safety: "read",
          callerRole: "agent",
          callerId: "chat-1",
          chatSessionId: "chat-1",
          costCents: 0,
          estimated: false,
          occurredAt: "2026-03-24T05:57:45.700Z",
        },
      ],
    });

    expect(snapshot.summary).toContain("Ghost OS is already active for this scope");
    expect(snapshot.activity.some((item) => item.kind === "backend_tool_used")).toBe(true);
  });

  it("surfaces Ghost doctor process health in the settings snapshot", () => {
    const snapshot = buildComputerUseSettingsSnapshot({
      status: createBackendStatus(),
      snapshots: [createGhostSnapshot()],
    });

    expect(snapshot.ghostOsCheck.processHealth?.state).toBe("stale");
    expect(snapshot.ghostOsCheck.details.join("\n")).toContain("Stop the stale `ghost mcp` processes");
  });
});
