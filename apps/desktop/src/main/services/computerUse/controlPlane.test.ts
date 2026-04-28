import type { ComputerUseBackendStatus } from "../../../shared/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ai/utils", () => ({
  commandExists: vi.fn(() => true),
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    stdout: "",
    stderr: "",
    error: null,
  })),
}));

import {
  buildComputerUseOwnerSnapshot,
  collectRequiredComputerUseKindsFromPhases,
} from "./controlPlane";

function createBackendStatus(): ComputerUseBackendStatus {
  return {
    backends: [
      {
        name: "Ghost OS",
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
    });

    expect(snapshot.summary).toContain("Ghost OS is available and ready to capture proof");
    expect(snapshot.activity.some((item) => item.kind === "backend_available")).toBe(true);
  });

  it("collects only supported proof kinds from required phases", () => {
    const phases = [
      {
        validationGate: {
          required: true,
          evidenceRequirements: ["screenshot", "browser_verification", "unsupported-evidence"],
        },
      },
      {
        validationGate: {
          required: false,
          evidenceRequirements: ["video_recording"],
        },
      },
      {
        validationGate: {
          required: true,
          evidenceRequirements: ["screenshot", "console_logs"],
        },
      },
    ] as any;

    expect(collectRequiredComputerUseKindsFromPhases(phases)).toEqual([
      "screenshot",
      "browser_verification",
      "console_logs",
    ]);
  });
});
