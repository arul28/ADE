/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../shared/types/core";
import { useAppStore } from "../state/appStore";
import { readAttachmentImageDataUrl } from "./attachmentImage";

const remotePin: OpenProjectBinding = {
  kind: "remote",
  key: "remote:studio:project-1",
  targetId: "studio",
  runtimeName: "Mac Studio",
  projectId: "project-1",
  rootPath: "/Users/admin/Projects/ADE",
  displayName: "ADE",
};
const localPin: OpenProjectBinding = {
  kind: "local",
  key: "local:/Users/me/ADE",
  rootPath: "/Users/me/ADE",
  displayName: "ADE",
};

describe("readAttachmentImageDataUrl", () => {
  const runtimeRead = vi.fn();
  const localRead = vi.fn();
  const originalBinding = useAppStore.getState().projectBinding;

  beforeEach(() => {
    runtimeRead.mockRejectedValue(new Error("Path does not exist."));
    localRead.mockResolvedValue({ dataUrl: "data:image/png;base64,LOCAL" });
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { getImageDataUrl: runtimeRead },
        app: { getImageDataUrl: localRead },
      },
    });
  });

  afterEach(() => {
    useAppStore.setState({ projectBinding: originalBinding });
    vi.clearAllMocks();
  });

  it("reads through the pin's runtime first", async () => {
    runtimeRead.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,RUNTIME" });
    await expect(readAttachmentImageDataUrl("/a.png", remotePin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,RUNTIME" });
    expect(runtimeRead).toHaveBeenCalledWith("/a.png", remotePin);
    expect(localRead).not.toHaveBeenCalled();
  });

  it("never reads a remote-pinned path on this computer", async () => {
    useAppStore.setState({ projectBinding: localPin });
    await expect(readAttachmentImageDataUrl("/remote.png", remotePin)).rejects.toThrow("Path does not exist.");
    expect(localRead).not.toHaveBeenCalled();
  });

  it("reads a local pin once, through the runtime, unless an older brain refuses a path outside the project", async () => {
    // The runtime's answer is final: one read, no second refusal from this computer.
    await expect(readAttachmentImageDataUrl("/gone.png", localPin)).rejects.toThrow("Path does not exist.");
    expect(localRead).not.toHaveBeenCalled();

    runtimeRead.mockRejectedValueOnce(new Error("Image path must be inside the project."));
    await expect(readAttachmentImageDataUrl("/local.png", localPin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,LOCAL" });
    expect(localRead).toHaveBeenCalledWith("/local.png");

    runtimeRead.mockRejectedValueOnce(new Error("Image path must be inside the project."));
    localRead.mockRejectedValueOnce(new Error("Path is outside allowed directories."));
    await expect(readAttachmentImageDataUrl("/outside.png", localPin)).rejects.toThrow("must be inside the project");
  });

  // Successful reads are cached per owner and path for the life of the
  // renderer, so each case reads paths no other case has read.
  it("treats no pin as the window's machine: local falls back, remote does not", async () => {
    runtimeRead.mockRejectedValue(new Error("Image path must be inside the project."));
    useAppStore.setState({ projectBinding: localPin });
    await expect(readAttachmentImageDataUrl("/no-pin-local.png", null))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,LOCAL" });
    expect(runtimeRead).toHaveBeenCalledWith("/no-pin-local.png", undefined);

    localRead.mockClear();
    useAppStore.setState({ projectBinding: remotePin });
    await expect(readAttachmentImageDataUrl("/no-pin-remote.png", null)).rejects.toThrow("must be inside the project");
    expect(localRead).not.toHaveBeenCalled();
  });

  it("uses this computer's reader when no runtime reader exists, but only for a path it owns", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { getImageDataUrl: localRead } },
    });
    await expect(readAttachmentImageDataUrl("/no-runtime-local.png", localPin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,LOCAL" });
    await expect(readAttachmentImageDataUrl("/no-runtime-remote.png", remotePin)).rejects.toThrow(/No image reader/);
    expect(localRead).toHaveBeenCalledTimes(1);
  });

  it("reads an attachment once per owner, retries a failed read, and reads fresh on request", async () => {
    runtimeRead.mockResolvedValue({ dataUrl: "data:image/png;base64,FIRST" });
    const first = readAttachmentImageDataUrl("/cache-once.png", remotePin);
    const concurrent = readAttachmentImageDataUrl("/cache-once.png", remotePin);
    await expect(first).resolves.toEqual({ dataUrl: "data:image/png;base64,FIRST" });
    await expect(concurrent).resolves.toEqual({ dataUrl: "data:image/png;base64,FIRST" });
    runtimeRead.mockResolvedValue({ dataUrl: "data:image/png;base64,SECOND" });
    await expect(readAttachmentImageDataUrl("/cache-once.png", remotePin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,FIRST" });
    expect(runtimeRead).toHaveBeenCalledTimes(1);

    // The same path on another owner is another file.
    await expect(readAttachmentImageDataUrl("/cache-once.png", localPin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,SECOND" });
    expect(runtimeRead).toHaveBeenCalledTimes(2);

    // A rewritable path (an image an agent viewed) is read once per version:
    // a new view reads the file again, a remount of the same view does not.
    await expect(readAttachmentImageDataUrl("/cache-once.png", remotePin, { version: "view-2" }))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,SECOND" });
    await expect(readAttachmentImageDataUrl("/cache-once.png", remotePin, { version: "view-2" }))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,SECOND" });
    expect(runtimeRead).toHaveBeenCalledTimes(3);

    // A failure is not an answer: the next read asks again.
    runtimeRead.mockRejectedValueOnce(new Error("runtime dropped"));
    await expect(readAttachmentImageDataUrl("/cache-retry.png", remotePin)).rejects.toThrow("runtime dropped");
    await expect(readAttachmentImageDataUrl("/cache-retry.png", remotePin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,SECOND" });
    expect(runtimeRead).toHaveBeenCalledTimes(5);
  });

  it("reads a personal chat's image only through its own reader, once per machine", async () => {
    const reader = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,PERSONAL" });
    await expect(readAttachmentImageDataUrl("/store/a.png", null, { reader }))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,PERSONAL" });
    await expect(readAttachmentImageDataUrl("/store/a.png", null, { reader }))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,PERSONAL" });
    // The same path on another machine is another file.
    await readAttachmentImageDataUrl("/store/a.png", remotePin, { reader });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(runtimeRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
  });
});
