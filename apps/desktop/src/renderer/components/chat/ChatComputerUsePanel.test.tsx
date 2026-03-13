/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultComputerUsePolicy, type ComputerUseOwnerSnapshot } from "../../../shared/types";
import { ChatComputerUsePanel } from "./ChatComputerUsePanel";

function createSnapshot(): ComputerUseOwnerSnapshot {
  return {
    owner: { kind: "chat_session", id: "session-1" },
    policy: createDefaultComputerUsePolicy(),
    backendStatus: {
      backends: [
        {
          name: "agent-browser",
          style: "external_cli",
          available: true,
          state: "installed",
          detail: "agent-browser CLI is installed and ready.",
          supportedKinds: ["screenshot", "browser_trace", "browser_verification", "console_logs", "video_recording"],
        },
      ],
      localFallback: {
        available: true,
        detail: "ADE local computer-use tools are available as a fallback.",
        supportedKinds: ["screenshot"],
      },
    },
    summary: "agent-browser captured the latest proof for this chat.",
    activeBackend: {
      name: "agent-browser",
      style: "external_cli",
      detail: "Most recent artifact came from agent-browser.",
      source: "artifact",
    },
    artifacts: [
      {
        id: "artifact-1",
        kind: "screenshot",
        backendStyle: "external_cli",
        backendName: "agent-browser",
        sourceToolName: "agent-browser",
        originalType: "screenshot",
        title: "Checkout screenshot",
        description: "Captured after the checkout flow.",
        uri: "/tmp/checkout.png",
        storageKind: "file",
        mimeType: "image/png",
        metadata: {},
        createdAt: "2026-03-12T14:00:00.000Z",
        links: [
          {
            id: "link-1",
            artifactId: "artifact-1",
            ownerKind: "chat_session",
            ownerId: "session-1",
            relation: "attached_to",
            metadata: null,
            createdAt: "2026-03-12T14:00:00.000Z",
          },
        ],
        reviewState: "pending",
        workflowState: "evidence_only",
        reviewNote: null,
      },
    ],
    recentArtifacts: [],
    activity: [],
    proofCoverage: {
      requiredKinds: ["screenshot"],
      presentKinds: ["screenshot"],
      missingKinds: [],
    },
    usingLocalFallback: false,
  };
}

describe("ChatComputerUsePanel", () => {
  beforeEach(() => {
    (window as any).ade = {
      computerUse: {
        routeArtifact: vi.fn(async () => {}),
        updateArtifactReview: vi.fn(async () => {}),
      },
      app: {
        openExternal: vi.fn(async () => {}),
        revealPath: vi.fn(async () => {}),
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("routes chat artifacts to preset and manual owners", async () => {
    const onRefresh = vi.fn(async () => {});
    render(
      <ChatComputerUsePanel
        laneId="lane-1"
        sessionId="session-1"
        policy={createDefaultComputerUsePolicy()}
        snapshot={createSnapshot()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Attach to lane/i }));
    await waitFor(() => {
      expect((window as any).ade.computerUse.routeArtifact).toHaveBeenCalledWith({
        artifactId: "artifact-1",
        owner: { kind: "lane", id: "lane-1" },
      });
    });

    fireEvent.change(screen.getByDisplayValue("mission"), { target: { value: "github_pr" } });
    fireEvent.change(screen.getByPlaceholderText("Target ID"), { target: { value: "123" } });
    const attachButton = screen.getByRole("button", { name: /^Attach$/i });
    await waitFor(() => {
      expect(attachButton.getAttribute("disabled")).toBeNull();
    });
    fireEvent.click(attachButton);

    await waitFor(() => {
      expect((window as any).ade.computerUse.routeArtifact).toHaveBeenCalledWith({
        artifactId: "artifact-1",
        owner: { kind: "github_pr", id: "123" },
      });
    });
  });

  it("updates artifact review state from the review controls", async () => {
    const onRefresh = vi.fn(async () => {});
    render(
      <ChatComputerUsePanel
        laneId="lane-1"
        sessionId="session-1"
        policy={createDefaultComputerUsePolicy()}
        snapshot={createSnapshot()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Accept/i }));
    expect((window as any).ade.computerUse.updateArtifactReview).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      reviewState: "accepted",
      workflowState: "promoted",
    });
  });
});
