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

function createArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-1",
    kind: "screenshot",
    backendStyle: "manual",
    backendName: "ade-cli",
    sourceToolName: null,
    originalType: null,
    title: "Checkout screen",
    description: null,
    uri: ".ade/artifacts/computer-use/shot.png",
    storageKind: "file",
    mimeType: "image/png",
    metadata: {},
    laneId: "lane-1",
    createdAt: "2026-03-12T14:00:00.000Z",
    links: [],
    reviewState: "accepted",
    workflowState: "evidence_only",
    reviewNote: null,
    availability: "available",
    ...overrides,
  } as any;
}

describe("computer use control plane", () => {
  it("reports backend readiness in the summary without fabricating activity events", () => {
    const snapshot = buildComputerUseOwnerSnapshot({
      broker: {
        getBackendStatus: vi.fn(() => createBackendStatus()),
        listArtifacts: vi.fn(() => []),
      } as any,
      owner: { kind: "chat_session", id: "chat-1" },
    });

    expect(snapshot.summary).toContain("Ghost OS is available and ready to capture proof");
    // Backend readiness is a current condition, not something that happened.
    // It belongs in the summary, never as a feed row stamped "just now".
    expect(snapshot.activity).toEqual([]);
  });

  it("derives activity from stored artifacts and keeps their real timestamps", () => {
    const snapshot = buildComputerUseOwnerSnapshot({
      broker: {
        getBackendStatus: vi.fn(() => createBackendStatus()),
        listArtifacts: vi.fn(() => [createArtifact()]),
      } as any,
      owner: { kind: "chat_session", id: "chat-1" },
    });

    expect(snapshot.activity).toHaveLength(1);
    expect(snapshot.activity[0]).toMatchObject({
      kind: "artifact_ingested",
      artifactId: "artifact-1",
      at: "2026-03-12T14:00:00.000Z",
      severity: "success",
    });
  });

  it("flags artifacts whose bytes were never imported as warnings", () => {
    const snapshot = buildComputerUseOwnerSnapshot({
      broker: {
        getBackendStatus: vi.fn(() => createBackendStatus()),
        listArtifacts: vi.fn(() => [createArtifact({ availability: "unimported" })]),
      } as any,
      owner: { kind: "chat_session", id: "chat-1" },
    });

    expect(snapshot.activity[0]?.severity).toBe("warning");
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
