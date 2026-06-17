/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeLinearIssueContextAttachment } from "../../../shared/chatContextAttachments";
import type { LaneLinearIssue } from "../../../shared/types";
import { ChatAttachmentTray } from "./ChatAttachmentTray";

function makeIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Connect chat context to Linear",
    description: null,
    url: "https://linear.app/ade/issue/ADE-123/connect-chat-context-to-linear",
    projectId: "project-1",
    projectSlug: "ade",
    projectName: "ADE",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: ["desktop"],
    assigneeId: "user-1",
    assigneeName: "Arul",
    creatorId: null,
    creatorName: null,
    dueDate: null,
    estimate: null,
    branchName: "ade-123-connect-chat-context-to-linear",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatAttachmentTray", () => {
  const getImageDataUrl = vi.fn();
  const getRuntimeImageDataUrl = vi.fn();
  const writeClipboardImage = vi.fn();

  beforeEach(() => {
    getImageDataUrl.mockResolvedValue({ dataUrl: "data:image/png;base64,abc123" });
    getRuntimeImageDataUrl.mockResolvedValue({ dataUrl: "data:image/png;base64,runtime123" });
    writeClipboardImage.mockResolvedValue(undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        app: {
          getImageDataUrl,
          writeClipboardImage,
        },
        agentChat: {
          getImageDataUrl: getRuntimeImageDataUrl,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders image attachments as previews that can expand", async () => {
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/screenshot.png", type: "image" }]}
        mode="standard"
      />,
    );

    await waitFor(() => expect(getRuntimeImageDataUrl).toHaveBeenCalledWith("/tmp/screenshot.png"));

    const openButton = screen.getByRole("button", { name: "Open screenshot.png" });
    expect(screen.getByAltText("screenshot.png").getAttribute("src")).toBe("data:image/png;base64,runtime123");

    fireEvent.click(openButton);

    expect(screen.getByRole("dialog", { name: "screenshot.png" })).toBeTruthy();
  });

  it("renders seeded image previews without reading the file back", () => {
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/pasted-image.png", type: "image" }]}
        imagePreviewUrls={{ "/tmp/pasted-image.png": "blob:ade-paste-preview" }}
        mode="standard"
      />,
    );

    expect(screen.getByAltText("pasted-image.png").getAttribute("src")).toBe("blob:ade-paste-preview");
    expect(getImageDataUrl).not.toHaveBeenCalled();
    expect(getRuntimeImageDataUrl).not.toHaveBeenCalled();
  });

  it("falls back to the local app image reader when no runtime preview reader is exposed", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        app: {
          getImageDataUrl,
          writeClipboardImage,
        },
      },
    });

    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/local-screenshot.png", type: "image" }]}
        mode="standard"
      />,
    );

    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledWith("/tmp/local-screenshot.png"));
    expect(screen.getByAltText("local-screenshot.png").getAttribute("src")).toBe("data:image/png;base64,abc123");
  });

  it("falls back to the guarded local image reader when runtime preview read fails", async () => {
    getRuntimeImageDataUrl.mockRejectedValueOnce(new Error("outside project"));

    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/local-outside-project.png", type: "image" }]}
        mode="standard"
      />,
    );

    await waitFor(() => expect(getRuntimeImageDataUrl).toHaveBeenCalledWith("/tmp/local-outside-project.png"));
    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledWith("/tmp/local-outside-project.png"));
    expect(screen.getByAltText("local-outside-project.png").getAttribute("src")).toBe("data:image/png;base64,abc123");
  });

  it("renders pending image attachments with cancellable previews", () => {
    const onRemovePendingImageAttachment = vi.fn();

    render(
      <ChatAttachmentTray
        attachments={[]}
        pendingImageAttachments={[{
          id: "pending-1",
          name: "clipboard.png",
          previewUrl: "blob:ade-pending-preview",
        }]}
        mode="standard"
        onRemovePendingImageAttachment={onRemovePendingImageAttachment}
      />,
    );

    expect(screen.getByRole("status", { name: "Attaching clipboard.png" })).toBeTruthy();
    expect(screen.getByAltText("clipboard.png preview").getAttribute("src")).toBe("blob:ade-pending-preview");

    fireEvent.click(screen.getByRole("button", { name: "Cancel clipboard.png" }));
    expect(onRemovePendingImageAttachment).toHaveBeenCalledWith("pending-1");
  });

  it("copies and removes image attachments from the preview controls", async () => {
    const onRemove = vi.fn();

    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/pasted-image.png", type: "image" }]}
        mode="standard"
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy pasted-image.png" }));
    await waitFor(() => expect(writeClipboardImage).toHaveBeenCalledWith("/tmp/pasted-image.png"));

    fireEvent.click(screen.getByRole("button", { name: "Remove pasted-image.png" }));
    expect(onRemove).toHaveBeenCalledWith("/tmp/pasted-image.png");
  });

  it("removes focused image attachments with delete keys and can return focus to the prompt", () => {
    const onRemove = vi.fn();
    const onFocusPrompt = vi.fn();

    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/pasted-image.png", type: "image" }]}
        mode="standard"
        onRemove={onRemove}
        onFocusPrompt={onFocusPrompt}
      />,
    );

    const openButton = screen.getByRole("button", { name: "Open pasted-image.png" });
    openButton.focus();

    fireEvent.keyDown(openButton, { key: "ArrowDown" });
    expect(onFocusPrompt).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(openButton, { key: "Backspace" });
    expect(onRemove).toHaveBeenCalledWith("/tmp/pasted-image.png");
    expect(onFocusPrompt).toHaveBeenCalledTimes(2);
  });

  it("keeps non-image attachments as filename chips", () => {
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/context.txt", type: "file" }]}
        mode="standard"
      />,
    );

    expect(screen.getByText("context.txt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open context.txt" })).toBeNull();
  });

  it("renders image URL attachments as URL chips without loading a local preview", () => {
    const onRemove = vi.fn();

    render(
      <ChatAttachmentTray
        attachments={[{ path: "https://example.com/diagram.png", type: "image-url", url: "https://example.com/diagram.png" }]}
        mode="standard"
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText("example.com")).toBeTruthy();
    expect(getImageDataUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }));
    expect(onRemove).toHaveBeenCalledWith("https://example.com/diagram.png");
  });

  it("renders removable Linear issue context chips", () => {
    const onRemoveContext = vi.fn();
    const contextAttachment = makeLinearIssueContextAttachment(makeIssue(), "manual");

    render(
      <ChatAttachmentTray
        attachments={[]}
        contextAttachments={[contextAttachment]}
        mode="standard"
        onRemoveContext={onRemoveContext}
      />,
    );

    expect(screen.getByTestId("linear-issue-context-chip")).toBeTruthy();
    expect(screen.getByText("ADE-123")).toBeTruthy();
    expect(screen.getByText("Connect chat context to Linear")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove ADE-123" }));

    expect(onRemoveContext).toHaveBeenCalledWith("linear:issue-1");
  });
});
