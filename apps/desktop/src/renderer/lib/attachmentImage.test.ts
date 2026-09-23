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

  it("falls back to this computer's reader for a local pin", async () => {
    await expect(readAttachmentImageDataUrl("/local.png", localPin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,LOCAL" });
    expect(localRead).toHaveBeenCalledWith("/local.png");
  });

  it("treats no pin as the window's machine: local falls back, remote does not", async () => {
    useAppStore.setState({ projectBinding: localPin });
    await expect(readAttachmentImageDataUrl("/local.png", null))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,LOCAL" });
    expect(runtimeRead).toHaveBeenCalledWith("/local.png", undefined);

    localRead.mockClear();
    useAppStore.setState({ projectBinding: remotePin });
    await expect(readAttachmentImageDataUrl("/remote.png", null)).rejects.toThrow("Path does not exist.");
    expect(localRead).not.toHaveBeenCalled();
  });

  it("uses this computer's reader when no runtime reader exists, but only for a path it owns", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { getImageDataUrl: localRead } },
    });
    await expect(readAttachmentImageDataUrl("/local.png", localPin))
      .resolves.toEqual({ dataUrl: "data:image/png;base64,LOCAL" });
    await expect(readAttachmentImageDataUrl("/remote.png", remotePin)).rejects.toThrow(/No image reader/);
    expect(localRead).toHaveBeenCalledTimes(1);
  });
});
