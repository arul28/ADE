import { describe, expect, it } from "vitest";
import { createDefaultComputerUsePolicy, type ComputerUseOwnerSnapshot } from "../../shared/types";
import {
  buildComputerUseRoutePresets,
  describeComputerUseLinks,
  summarizeComputerUseProof,
} from "./computerUse";

function createSnapshot(overrides: Partial<ComputerUseOwnerSnapshot> = {}): ComputerUseOwnerSnapshot {
  return {
    owner: { kind: "mission", id: "mission-1" },
    policy: createDefaultComputerUsePolicy(),
    backendStatus: {
      backends: [],
      localFallback: {
        available: true,
        detail: "Fallback only",
        supportedKinds: ["screenshot"],
      },
    },
    summary: "summary",
    activeBackend: null,
    artifacts: [],
    recentArtifacts: [],
    activity: [],
    proofCoverage: {
      requiredKinds: ["screenshot"],
      presentKinds: [],
      missingKinds: ["screenshot"],
    },
    usingLocalFallback: false,
    ...overrides,
  };
}

describe("computerUse renderer helpers", () => {
  it("builds route presets for chat, mission, and lane owners", () => {
    expect(buildComputerUseRoutePresets({
      chatSessionId: "chat-1",
      missionId: "mission-1",
      laneId: "lane-1",
    })).toEqual([
      { label: "Keep in chat", owner: { kind: "chat_session", id: "chat-1" } },
      { label: "Attach to mission", owner: { kind: "mission", id: "mission-1" } },
      { label: "Attach to lane", owner: { kind: "lane", id: "lane-1" } },
    ]);
  });

  it("describes linked owners and proof coverage clearly", () => {
    expect(describeComputerUseLinks([
      {
        id: "link-1",
        artifactId: "artifact-1",
        ownerKind: "mission",
        ownerId: "mission-1",
        relation: "attached_to",
        metadata: null,
        createdAt: "2026-03-12T14:00:00.000Z",
      },
      {
        id: "link-2",
        artifactId: "artifact-1",
        ownerKind: "lane",
        ownerId: "lane-1",
        relation: "attached_to",
        metadata: null,
        createdAt: "2026-03-12T14:01:00.000Z",
      },
    ])).toBe("mission:mission-1 • lane:lane-1");

    expect(summarizeComputerUseProof(createSnapshot())).toBe("Missing proof: screenshot");
    expect(summarizeComputerUseProof(createSnapshot({
      artifacts: [{
        id: "artifact-1",
        kind: "screenshot",
        backendStyle: "external_cli",
        backendName: "agent-browser",
        sourceToolName: null,
        originalType: null,
        title: "artifact",
        description: null,
        uri: "/tmp/artifact.png",
        storageKind: "file",
        mimeType: "image/png",
        metadata: {},
        createdAt: "2026-03-12T14:00:00.000Z",
        links: [],
        reviewState: "pending",
        workflowState: "evidence_only",
        reviewNote: null,
      }],
      proofCoverage: {
        requiredKinds: ["screenshot"],
        presentKinds: ["screenshot"],
        missingKinds: [],
      },
    }))).toBe("Proof satisfied: screenshot");
  });
});
