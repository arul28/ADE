import type { ComputerUseBackendStatus } from "../../../shared/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ai/utils", () => ({
  commandExists: vi.fn(() => true),
}));

vi.mock("./localComputerUse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./localComputerUse")>();
  return {
    ...actual,
    getGhostDoctorProcessHealth: vi.fn(() => ({
      state: "stale" as const,
      processCount: 34,
      detail: "34 Ghost OS processes found (expect 0 or 1).",
    })),
  };
});

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((command: string, args: string[]) => {
    if (command === "ghost" && args[0] === "doctor") {
      return {
        stdout: "[FAIL] Processes: 34 Ghost OS processes found (expect 0 or 1)\n",
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
        style: "external_cli",
        available: true,
        state: "installed",
        detail: "Connected CLI backend with 12 tool(s).",
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

describe("computer use control plane", () => {
  it("shows live backend activity when a backend is available", () => {
    const snapshot = buildComputerUseOwnerSnapshot({
      broker: {
        getBackendStatus: vi.fn(() => createBackendStatus()),
        listArtifacts: vi.fn(() => []),
      } as any,
      owner: { kind: "chat_session", id: "chat-1" },
      policy: null,
    });

    expect(snapshot.summary).toContain("Ghost OS is available and ready to capture proof");
    expect(snapshot.activity.some((item) => item.kind === "backend_available")).toBe(true);
  });

  it("surfaces Ghost doctor process health in the settings snapshot", () => {
    const snapshot = buildComputerUseSettingsSnapshot({
      status: createBackendStatus(),
    });

    expect(snapshot.ghostOsCheck.processHealth?.state).toBe("stale");
    expect(snapshot.ghostOsCheck.details.join("\n")).toContain("Stop the stale Ghost OS processes");
  });
});
