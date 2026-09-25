/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseArtifactView, ComputerUseOwnerSnapshot } from "../../../shared/types";
import {
  ChatComputerUsePanel,
  ChatProofTimeline,
} from "./ChatComputerUsePanel";

// The chat's machine, overridable per test. Null keeps the real fallback scope.
const scopeOverride = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("./ChatRuntimeScope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ChatRuntimeScope")>();
  return {
    ...actual,
    useChatRuntimeScope: () => ({ ...actual.useChatRuntimeScope(), ...scopeOverride.current }),
  };
});

const REMOTE_BINDING = {
  kind: "remote" as const,
  key: "remote:target-1:project-1",
  targetId: "target-1",
  runtimeName: "MacBook Pro",
  projectId: "project-1",
  rootPath: "/Users/other/repo",
  displayName: "repo",
};

function remoteScope(online: boolean) {
  return {
    pin: REMOTE_BINDING,
    binding: REMOTE_BINDING,
    rootPath: REMOTE_BINDING.rootPath,
    isRemote: true,
    machineName: "MacBook Pro",
    online,
  };
}

function recording(index: number, overrides: Partial<ComputerUseArtifactView> = {}): ComputerUseArtifactView {
  return artifact(index, {
    title: `Recording ${index}`,
    kind: "video_recording",
    originalType: "video",
    mimeType: "video/quicktime",
    uri: ".ade/artifacts/apple-recordings/lane-1/rec.mov",
    ...overrides,
  });
}

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

function snapshotOf(artifacts: ComputerUseArtifactView[]): ComputerUseOwnerSnapshot {
  return {
    owner: { kind: "chat_session", id: "session-1" },
    backendStatus: {
      backends: [],
      localFallback: { available: true, detail: "Available", supportedKinds: ["screenshot"] },
    },
    summary: `${artifacts.length} proof item`,
    activeBackend: null,
    artifacts,
    recentArtifacts: artifacts,
    activity: [],
  };
}

const MEDIA_BASE = "http://127.0.0.1:43210/tok";

beforeEach(() => {
  delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  (window as unknown as { ade: unknown }).ade = {
    computerUse: {
      readArtifactPreview: vi.fn().mockResolvedValue("data:image/png;base64,AAAA"),
      mediaBaseUrl: vi.fn().mockResolvedValue(MEDIA_BASE),
    },
    app: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
  };
});

afterEach(() => {
  cleanup();
  scopeOverride.current = null;
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
    }, null);
    expect(screen.queryByText(/accept proof/i)).toBeNull();
    expect(screen.queryByText(/reveal in finder/i)).toBeNull();
  });

  it("opens an in-app lightbox instead of handing local proof to the operating system", async () => {
    render(<ChatProofTimeline artifacts={[artifact(2)]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Enlarge Proof 2" }));

    const dialog = screen.getByRole("dialog", { name: "Preview Proof 2" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(dialog.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close proof preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("plays large local recordings from the media server, not the artifact protocol", async () => {
    // 2026-09-23: `protocol.handle` failed the tail Range read a long MP4
    // needs, so the drawer said "ADE could not play this video".
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
      expect(view.container.querySelector("video")?.getAttribute("src"))
        .toBe(`${MEDIA_BASE}/project/.ade/artifacts/proof.mov`);
    });
  });

  it("keeps local images on the artifact protocol", async () => {
    const view = render(<ChatProofTimeline allowLocalArtifactProtocol artifacts={[artifact(5)]} />);

    await waitFor(() => {
      expect(view.container.querySelector("img")?.getAttribute("src"))
        .toBe("ade-artifact://project/.ade/artifacts/proof-5.png");
    });
    expect(window.ade.computerUse.mediaBaseUrl).not.toHaveBeenCalled();
    expect(window.ade.computerUse.readArtifactPreview).not.toHaveBeenCalled();
  });

  it("reads a local video the capped way when main has no media server", async () => {
    vi.mocked(window.ade.computerUse.mediaBaseUrl).mockResolvedValueOnce(null);
    vi.mocked(window.ade.computerUse.readArtifactPreview).mockResolvedValueOnce("data:video/mp4;base64,EEEE");
    const view = render(<ChatProofTimeline allowLocalArtifactProtocol artifacts={[recording(6)]} />);

    await waitFor(() => {
      expect(view.container.querySelector("video")?.getAttribute("src")).toBe("data:video/mp4;base64,EEEE");
    });
  });

  it("streams a large local recording filed with a project-relative uri", async () => {
    // The owner's 2026-09-23 report: a 41 MB recording showed "A preview is
    // unavailable" because only `ade-artifact://project/` uris streamed.
    const view = render(
      <ChatComputerUsePanel
        allowLocalArtifactProtocol
        snapshot={snapshotOf([recording(20)])}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(view.container.querySelector("video")?.getAttribute("src"))
        .toBe(`${MEDIA_BASE}/project/.ade/artifacts/apple-recordings/lane-1/rec.mov`);
    });
    expect(view.container.querySelector("video")?.getAttribute("preload")).toBe("metadata");
    expect(window.ade.computerUse.readArtifactPreview).not.toHaveBeenCalled();
  });

  it("streams an absolute path inside the project and reads one outside it the old way", async () => {
    scopeOverride.current = { rootPath: "/Users/me/repo" };
    const view = render(
      <ChatComputerUsePanel
        allowLocalArtifactProtocol
        snapshot={snapshotOf([
          recording(21, { uri: "/Users/me/repo/.ade/artifacts/inside.mp4" }),
          recording(22, { uri: "/Users/me/elsewhere/outside.mp4" }),
        ])}
        onRefresh={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(view.container.querySelector('[data-chat-proof-artifact="artifact-21"] video')?.getAttribute("src"))
        .toBe(`${MEDIA_BASE}/project/.ade/artifacts/inside.mp4?root=${encodeURIComponent("/Users/me/repo")}`);
    });
    expect(window.ade.computerUse.readArtifactPreview).toHaveBeenCalledTimes(1);
    expect(window.ade.computerUse.readArtifactPreview)
      .toHaveBeenCalledWith({ uri: "/Users/me/elsewhere/outside.mp4" }, null);
  });

  it("streams a video on a paired computer through main instead of a capped data URL", async () => {
    scopeOverride.current = remoteScope(true);
    const view = render(
      <ChatComputerUsePanel snapshot={snapshotOf([recording(23), artifact(24)])} onRefresh={vi.fn()} />,
    );

    await waitFor(() => {
      expect(view.container.querySelector("video")?.getAttribute("src"))
        .toBe(`${MEDIA_BASE}/remote/target-1/project-1/.ade/artifacts/apple-recordings/lane-1/rec.mov`);
    });
    expect(view.container.querySelector("video")?.getAttribute("preload")).toBe("metadata");
    // Only the image took the data URL read.
    expect(window.ade.computerUse.readArtifactPreview).toHaveBeenCalledTimes(1);
    expect(window.ade.computerUse.readArtifactPreview)
      .toHaveBeenCalledWith({ uri: ".ade/artifacts/proof-24.png" }, REMOTE_BINDING);
  });

  it("falls back to the data URL when a paired computer cannot stream, and says so if that fails too", async () => {
    scopeOverride.current = remoteScope(true);
    vi.mocked(window.ade.computerUse.readArtifactPreview)
      .mockResolvedValueOnce("data:video/quicktime;base64,DDDD");
    const view = render(<ChatProofTimeline artifacts={[recording(25)]} />);

    const streamed = await waitFor(() => {
      const video = view.container.querySelector("video");
      expect(video?.getAttribute("src")).toBe(
        `${MEDIA_BASE}/remote/target-1/project-1/.ade/artifacts/apple-recordings/lane-1/rec.mov`,
      );
      return video!;
    });
    fireEvent.error(streamed);
    await waitFor(() => {
      expect(view.container.querySelector("video")?.getAttribute("src")).toBe("data:video/mp4;base64,DDDD");
    });

    cleanup();
    vi.mocked(window.ade.computerUse.readArtifactPreview).mockResolvedValueOnce(null);
    const second = render(<ChatProofTimeline artifacts={[recording(26)]} />);
    const again = await waitFor(() => {
      const video = second.container.querySelector("video");
      expect(video).toBeTruthy();
      return video!;
    });
    fireEvent.error(again);
    expect(await screen.findByText("MacBook Pro could not send this video.")).toBeTruthy();
  });

  it("says which computer is offline instead of the generic line", async () => {
    scopeOverride.current = remoteScope(false);
    render(<ChatComputerUsePanel snapshot={snapshotOf([recording(27)])} onRefresh={vi.fn()} />);

    expect(await screen.findByText("This video is on MacBook Pro, which is offline.")).toBeTruthy();
    expect(screen.queryByText(/preview is unavailable/i)).toBeNull();
    expect(window.ade.computerUse.readArtifactPreview).not.toHaveBeenCalled();
  });

  it("reloads an offline proof tile when the machine comes back online", async () => {
    scopeOverride.current = remoteScope(false);
    const snapshot = snapshotOf([recording(28)]);
    const view = render(<ChatComputerUsePanel snapshot={snapshot} onRefresh={vi.fn()} />);
    expect(await screen.findByText("This video is on MacBook Pro, which is offline.")).toBeTruthy();

    scopeOverride.current = remoteScope(true);
    view.rerender(<ChatComputerUsePanel snapshot={snapshot} onRefresh={vi.fn()} />);

    await waitFor(() => {
      expect(view.container.querySelector("video")?.getAttribute("src"))
        .toBe(`${MEDIA_BASE}/remote/target-1/project-1/.ade/artifacts/apple-recordings/lane-1/rec.mov`);
    });
    expect(screen.queryByText(/which is offline/)).toBeNull();
  });

  it("plays a QuickTime proof from another machine as MP4", async () => {
    // The owner's 2026-09-23 report: a simctl `.mov` played on the phone and
    // failed on both desktops, because Chromium refuses `video/quicktime`.
    vi.mocked(window.ade.computerUse.readArtifactPreview)
      .mockResolvedValueOnce("data:video/quicktime;base64,AAAA");
    const view = render(
      <ChatProofTimeline
        artifacts={[artifact(4, {
          kind: "video_recording",
          originalType: "video",
          mimeType: "video/quicktime",
          uri: ".ade/artifacts/proof.mov",
        })]}
      />,
    );

    await waitFor(() => {
      expect(view.container.querySelector("video")?.getAttribute("src")).toBe("data:video/mp4;base64,AAAA");
    });
  });

  it("shows a video proof as an uncropped still and plays it in the lightbox", async () => {
    // The owner's 2026-09-23 report: the tile cropped a phone recording into a
    // zoomed strip and crammed native controls into it.
    vi.mocked(window.ade.computerUse.readArtifactPreview)
      .mockResolvedValue("data:video/mp4;base64,AAAA");
    const recording = artifact(10, {
      title: "Sim recording",
      kind: "video_recording",
      originalType: "video",
      mimeType: "video/mp4",
      uri: ".ade/artifacts/recording.mp4",
    });
    const view = render(<ChatComputerUsePanel snapshot={snapshotOf([recording])} onRefresh={vi.fn()} />);

    const poster = await screen.findByRole("button", { name: "Play Sim recording" });
    const still = poster.querySelector("video");
    expect(still?.getAttribute("src")).toBe("data:video/mp4;base64,AAAA");
    expect(still?.hasAttribute("controls")).toBe(false);
    expect(still?.getAttribute("preload")).toBe("metadata");
    expect(still?.className).toContain("object-contain");
    expect(still?.className).not.toContain("object-cover");
    expect(view.container.querySelector("video[controls]")).toBeNull();

    fireEvent.click(poster);
    const dialog = screen.getByRole("dialog", { name: "Preview Sim recording" });
    const player = dialog.querySelector("video");
    expect(player?.hasAttribute("controls")).toBe(true);
    expect(player?.getAttribute("src")).toBe("data:video/mp4;base64,AAAA");
    expect(player?.className).toContain("object-contain");
    expect(player?.className).not.toContain("object-cover");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Play Sim recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Close proof preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the timeline video card in the lightbox from a real button", async () => {
    vi.mocked(window.ade.computerUse.readArtifactPreview)
      .mockResolvedValueOnce("data:video/mp4;base64,BBBB");
    render(
      <ChatProofTimeline
        artifacts={[artifact(11, {
          kind: "video_recording",
          originalType: "video",
          mimeType: "video/mp4",
          uri: ".ade/artifacts/wide.mp4",
        })]}
      />,
    );

    const poster = await screen.findByRole("button", { name: "Play Proof 11" });
    expect(poster.tagName).toBe("BUTTON");
    expect(poster.querySelector("video")?.hasAttribute("controls")).toBe(false);
    fireEvent.click(poster);
    expect(screen.getByRole("dialog", { name: "Preview Proof 11" }).querySelector("video[controls]")
      ?.getAttribute("src")).toBe("data:video/mp4;base64,BBBB");
  });

  it("explains a video that fails to play inside the lightbox", async () => {
    vi.mocked(window.ade.computerUse.readArtifactPreview)
      .mockResolvedValueOnce("data:video/mp4;base64,CCCC");
    render(
      <ChatProofTimeline
        artifacts={[artifact(12, {
          kind: "video_recording",
          originalType: "video",
          mimeType: "video/mp4",
          uri: ".ade/artifacts/broken.mp4",
        })]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Play Proof 12" }));
    const dialog = screen.getByRole("dialog", { name: "Preview Proof 12" });
    fireEvent.error(dialog.querySelector("video")!);

    await waitFor(() => expect(dialog.querySelector("video")).toBeNull());
    expect(dialog.textContent).toMatch(/ADE could not play this video\./);
  });

  it("distinguishes an unavailable preview from a deleted stored file", async () => {
    vi.mocked(window.ade.computerUse.readArtifactPreview).mockResolvedValueOnce(null);

    render(<ChatComputerUsePanel
      snapshot={snapshotOf([artifact(5)])}
      onRefresh={vi.fn()}
    />);

    expect(await screen.findByText(/preview is unavailable, but the stored proof is still attached/i)).toBeTruthy();
    expect(screen.queryByText(/stored file has since been deleted/i)).toBeNull();
  });

  it("reports a missing stored file as deleted", async () => {
    render(<ChatComputerUsePanel
      snapshot={snapshotOf([artifact(6, { availability: "missing_file" })])}
      onRefresh={vi.fn()}
    />);

    expect(await screen.findByText(/stored file has since been deleted/i)).toBeTruthy();
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

  it("deletes a drawer item and refreshes, instead of leaving the user no way to remove it", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const deleteArtifacts = vi.fn().mockResolvedValue({ deleted: [], missing: [], failed: [], freedBytes: 0 });
    (window.ade as any).computerUse.deleteArtifacts = deleteArtifacts;

    render(<ChatComputerUsePanel snapshot={snapshotOf([artifact(1)])} onRefresh={onRefresh} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Proof 1" }));

    await waitFor(() => expect(deleteArtifacts).toHaveBeenCalledWith({ artifactId: "artifact-1" }, null));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("explains why a never-imported capture is blank and offers to locate or remove it", async () => {
    const readPreview = vi.mocked(window.ade.computerUse.readArtifactPreview);
    const recoverArtifact = vi.fn().mockResolvedValue({});
    (window.ade as any).computerUse.recoverArtifact = recoverArtifact;
    (window.ade as any).computerUse.deleteArtifacts = vi.fn().mockResolvedValue({});

    const broken = artifact(4, {
      title: "Lost proof",
      availability: "unimported",
      uri: "shots/proof.png",
      metadata: {
        sourcePath: "shots/proof.png",
        callerRoot: "/project/.ade/worktrees/lane-a",
      },
    });
    render(<ChatComputerUsePanel snapshot={snapshotOf([broken])} onRefresh={vi.fn()} />);

    // Honest, specific copy — not "Preview unavailable from the connected runtime."
    expect(await screen.findByText(/Never copied into ADE's storage/)).toBeTruthy();
    expect(screen.getByText(/1 item has no stored file/)).toBeTruthy();
    // No point asking the host for bytes it already told us do not exist.
    expect(readPreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Locate Lost proof in its lane" }));
    await waitFor(() => expect(recoverArtifact).toHaveBeenCalledWith({ artifactId: "artifact-4" }, null));
  });

  it("offers recovery for a local source URI but not an HTTP source URI", async () => {
    const recoverArtifact = vi.fn().mockResolvedValue({});
    (window.ade as any).computerUse.recoverArtifact = recoverArtifact;

    const localUri = artifact(8, {
      title: "URI proof",
      availability: "unimported",
      metadata: {
        sourceUri: "shots/from-uri.png",
        callerRoot: "/project/.ade/worktrees/lane-b",
      },
    });
    const remoteUri = artifact(9, {
      title: "Remote proof",
      availability: "unimported",
      metadata: { sourceUri: "https://example.com/proof.png" },
    });
    render(
      <ChatComputerUsePanel
        snapshot={snapshotOf([localUri, remoteUri])}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Locate URI proof in its lane" }));
    await waitFor(() => expect(recoverArtifact).toHaveBeenCalledWith({ artifactId: "artifact-8" }, null));
    expect(screen.queryByRole("button", { name: "Locate Remote proof in its lane" })).toBeNull();
  });

  it("surfaces a failed delete instead of silently doing nothing", async () => {
    (window.ade as any).computerUse.deleteArtifacts = vi.fn().mockRejectedValue(new Error("Artifact is locked"));

    render(<ChatComputerUsePanel snapshot={snapshotOf([artifact(1)])} onRefresh={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Proof 1" }));

    expect(await screen.findByText("Artifact is locked")).toBeTruthy();
  });

  it("surfaces resolved delete failures and does not refresh unchanged proof", async () => {
    const onRefresh = vi.fn();
    (window.ade as any).computerUse.deleteArtifacts = vi.fn().mockResolvedValue({
      deleted: [],
      missing: [],
      failed: [{ artifactId: "artifact-1", reason: "Permission denied" }],
      freedBytes: 0,
    });

    render(<ChatComputerUsePanel snapshot={snapshotOf([artifact(1)])} onRefresh={onRefresh} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Proof 1" }));

    expect(await screen.findByText("Permission denied")).toBeTruthy();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("surfaces resolved bulk-prune failures", async () => {
    const broken = artifact(7, { availability: "missing_file" });
    (window.ade as any).computerUse.deleteArtifacts = vi.fn().mockResolvedValue({
      deleted: [],
      missing: [],
      failed: [{ artifactId: broken.id, reason: "File is locked" }],
      freedBytes: 0,
    });

    render(<ChatComputerUsePanel snapshot={snapshotOf([broken])} onRefresh={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove it" }));

    expect(await screen.findByText("File is locked")).toBeTruthy();
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

describe("proof provenance lines", () => {
  // Local wall-clock times, so the clock text is the same in every time zone.
  const at = (hour: number, minute: number) => new Date(2026, 8, 23, hour, minute).toISOString();
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("says an ADE recording was recorded by ADE, with its times, in the drawer and the timeline", () => {
    const recorded = artifact(1, {
      kind: "video_recording",
      mimeType: "video/mp4",
      metadata: { proofSource: "ade-recorder", recordedFrom: at(10, 24), recordedTo: at(10, 25) },
    });
    render(<ChatComputerUsePanel snapshot={snapshotOf([recorded])} onRefresh={vi.fn()} />);
    const drawerLine = document.querySelector("[data-proof-source]")!;
    expect(drawerLine.textContent).toMatch(/^Recorded by ADE · 10:24/);
    expect(drawerLine.textContent).toContain(clock(at(10, 25)));
    cleanup();

    render(<ChatProofTimeline artifacts={[recorded]} />);
    expect(document.querySelector("[data-proof-source]")!.textContent).toMatch(/^Recorded by ADE · 10:24/);
  });

  it("says captured by ADE, or attached by the agent", () => {
    render(
      <ChatComputerUsePanel
        snapshot={snapshotOf([
          artifact(1, { metadata: { proofSource: "ade-capture" } }),
          artifact(2, { metadata: { proofSource: "attached" } }),
        ])}
        onRefresh={vi.fn()}
      />,
    );
    const lines = [...document.querySelectorAll("[data-proof-source]")].map((node) => node.textContent);
    expect(lines).toEqual(["Captured by ADE", "Attached by the agent"]);
  });

  it("shows nothing for a row filed before provenance existed", () => {
    render(<ChatComputerUsePanel snapshot={snapshotOf([artifact(1)])} onRefresh={vi.fn()} />);
    expect(document.querySelector("[data-proof-source]")).toBeNull();
    expect(document.querySelector("[data-proof-recorded-before-request]")).toBeNull();
  });

  it("adds an amber line for a video recorded before the request", () => {
    const older = artifact(1, {
      kind: "video_recording",
      mimeType: "video/mp4",
      metadata: { proofSource: "attached", mediaCreatedAt: at(5, 19), recordedBeforeRequest: true },
    });
    render(<ChatProofTimeline artifacts={[older]} />);
    const line = document.querySelector("[data-proof-recorded-before-request]")!;
    expect(line.textContent).toBe(`Recorded at ${clock(at(5, 19))}, before this request.`);
    expect(line.className).toContain("text-amber-200");
    expect(document.querySelector("[data-proof-source]")!.textContent).toBe("Attached by the agent");
  });
});
