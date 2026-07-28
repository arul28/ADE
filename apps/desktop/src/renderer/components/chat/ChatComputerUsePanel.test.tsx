/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseArtifactView, ComputerUseOwnerSnapshot } from "../../../shared/types";
import {
  ChatComputerUsePanel,
  ChatProofTimeline,
} from "./ChatComputerUsePanel";

function artifact(index: number, overrides: Partial<ComputerUseArtifactView> = {}): ComputerUseArtifactView {
  return {
    id: `artifact-${index}`,
    kind: "screenshot",
    backendStyle: "local_fallback",
    backendName: "Codex Computer Use",
    sourceToolName: "capture_screenshot",
    originalType: "image",
    title: `Proof ${index}`,
    description: `Description ${index}`,
    uri: `.ade/artifacts/proof-${index}.png`,
    storageKind: "file",
    mimeType: "image/png",
    metadata: {},
    createdAt: `2026-07-28T12:00:${String(index).padStart(2, "0")}.000Z`,
    links: [],
    reviewState: "pending",
    workflowState: "evidence_only",
    reviewNote: null,
    ...overrides,
  };
}

beforeEach(() => {
  delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  (window as unknown as { ade: unknown }).ade = {
    computerUse: {
      readArtifactPreview: vi.fn().mockResolvedValue("data:image/png;base64,AAAA"),
    },
    app: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("proof rendering", () => {
  it("renders runtime-fetched image proof in the drawer without review or Finder actions", async () => {
    const snapshot: ComputerUseOwnerSnapshot = {
      owner: { kind: "chat_session", id: "session-1" },
      backendStatus: {
        backends: [],
        localFallback: {
          available: true,
          detail: "Available",
          supportedKinds: ["screenshot"],
        },
      },
      summary: "1 proof item",
      activeBackend: null,
      artifacts: [artifact(1)],
      recentArtifacts: [artifact(1)],
      activity: [],
    };
    render(
      <ChatComputerUsePanel
        snapshot={snapshot}
        onRefresh={vi.fn()}
      />,
    );

    expect((await screen.findByRole("img", { name: "Proof 1" })).getAttribute("src"))
      .toBe("data:image/png;base64,AAAA");
    expect(window.ade.computerUse.readArtifactPreview).toHaveBeenCalledWith({
      uri: ".ade/artifacts/proof-1.png",
    });
    expect(screen.queryByText(/accept proof/i)).toBeNull();
    expect(screen.queryByText(/reveal in finder/i)).toBeNull();
  });

  it("opens an in-app lightbox instead of handing local proof to the operating system", async () => {
    render(<ChatProofTimeline artifacts={[artifact(2)]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Enlarge Proof 2" }));

    expect(screen.getByRole("dialog", { name: "Preview Proof 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close proof preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps large local recordings on the range-capable artifact protocol", async () => {
    vi.mocked(window.ade.computerUse.readArtifactPreview).mockResolvedValueOnce(null);
    const uri = "ade-artifact://project/.ade/artifacts/proof.mov";
    const view = render(
      <ChatProofTimeline
        allowLocalArtifactProtocol
        artifacts={[artifact(3, {
          kind: "video_recording",
          originalType: "video",
          mimeType: "video/quicktime",
          uri,
        })]}
      />,
    );

    await waitFor(() => {
      expect(view.container.querySelector("video")?.getAttribute("src")).toBe(uri);
    });
  });

  it("keeps the latest six proof items inline and links earlier proof to the drawer", async () => {
    const onOpenDrawer = vi.fn();
    render(
      <ChatProofTimeline
        artifacts={Array.from({ length: 8 }, (_, index) => artifact(index))}
        onOpenDrawer={onOpenDrawer}
      />,
    );

    expect(screen.queryByText("Proof 0")).toBeNull();
    expect(screen.queryByText("Proof 1")).toBeNull();
    expect(screen.getByText("Proof 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View 2 earlier proof items" }));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it("uses a remote-safe external action only for HTTP artifacts", async () => {
    const remote = artifact(3, {
      uri: "https://proof.example/capture.png",
      storageKind: "url",
    });
    render(<ChatProofTimeline artifacts={[remote]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(window.ade.app.openExternal).toHaveBeenCalledWith(remote.uri);
  });
});
