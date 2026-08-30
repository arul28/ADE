/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeGitHubIssueContextAttachment, makeLinearIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { githubIssueIdentifier } from "../../../shared/laneGitHubIssue";
import type { LaneGitHubIssue, LaneLinearIssue } from "../../../shared/types";
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
  const listWorkspaces = vi.fn();

  beforeEach(() => {
    listWorkspaces.mockResolvedValue([
      { id: "primary", kind: "primary", laneId: null, name: "ADE", branchRef: null, rootPath: "/tmp", isReadOnlyByDefault: false, mobileReadOnly: true },
    ]);
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
        files: {
          listWorkspaces,
          readFile: vi.fn(async () => {
            throw new Error("not needed for image previews");
          }),
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

    // The preview popup is code-split, so it resolves a tick after the click.
    expect(await screen.findByRole("dialog", { name: "screenshot.png" })).toBeTruthy();
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

  it("renders non-image attachments as openable filename chips", () => {
    // Non-image attachments used to be inert filename pills. Every attachment
    // now opens in the universal preview, so the chip is the affordance.
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/tmp/context.txt", type: "file" }]}
        mode="standard"
      />,
    );

    expect(screen.getByText("context.txt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open context.txt" })).toBeTruthy();
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

  it("renders removable GitHub issue context chips", () => {
    const onRemoveContext = vi.fn();
    const issue: LaneGitHubIssue = {
      id: "ade/app#42",
      number: 42,
      owner: "ade",
      repo: "app",
      title: "Fix attach menu",
      body: "Details",
      url: "https://github.com/ade/app/issues/42",
      state: "open",
      stateReason: null,
      labels: ["bug"],
      assignees: [],
      authorLogin: "arul",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const contextAttachment = makeGitHubIssueContextAttachment(issue, "manual");

    render(
      <ChatAttachmentTray
        attachments={[]}
        contextAttachments={[contextAttachment]}
        mode="standard"
        onRemoveContext={onRemoveContext}
      />,
    );

    expect(screen.getByTestId("github-issue-context-chip")).toBeTruthy();
    expect(screen.getByText(githubIssueIdentifier(issue))).toBeTruthy();
    expect(screen.getByText("Fix attach menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Remove ${githubIssueIdentifier(issue)}` }));

    expect(onRemoveContext).toHaveBeenCalledWith("github:ade/app#42");
  });
});

describe("ChatAttachmentTray file chips", () => {
  const listWorkspaces = vi.fn();
  const readFile = vi.fn();

  beforeEach(() => {
    readFile.mockResolvedValue({
      path: ".ade/attachments/9f3a.csv",
      content: "a,b\n1,2\n",
      encoding: "utf-8",
      size: 8,
      totalSize: 8,
      isBinary: false,
      isPartial: false,
    });
    listWorkspaces.mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: null,
        rootPath: "/Users/a/Projects/ADE",
        isReadOnlyByDefault: false,
        mobileReadOnly: true,
      },
    ]);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: {}, agentChat: {}, files: { listWorkspaces, readFile } },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders a non-image attachment as a chip with its name and size", () => {
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/Users/a/Projects/ADE/.ade/attachments/9f3a.pdf", type: "file" }]}
        attachmentSizes={{ "/Users/a/Projects/ADE/.ade/attachments/9f3a.pdf": 2_411_724 }}
        mode="standard"
        onRemove={() => undefined}
      />,
    );

    const chip = screen.getByTestId("chat-file-attachment-chip");
    expect(chip.textContent).toContain("9f3a.pdf");
    expect(chip.textContent).toContain("2.3 MB");
    expect(screen.getByRole("button", { name: "Remove 9f3a.pdf" })).toBeTruthy();
  });

  it("omits the size when the caller does not know it", () => {
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/Users/a/Projects/ADE/.ade/attachments/notes.txt", type: "file" }]}
        mode="standard"
      />,
    );
    const chip = screen.getByTestId("chat-file-attachment-chip");
    expect(chip.textContent).toContain("notes.txt");
    expect(chip.textContent).not.toMatch(/\d+(\.\d+)? (B|KB|MB|GB)/);
  });

  it("middle-truncates a long filename so the extension survives", () => {
    render(
      <ChatAttachmentTray
        attachments={[{
          path: "/Users/a/Projects/ADE/.ade/attachments/quarterly-engineering-report-final-v7.xlsx",
          type: "file",
        }]}
        mode="standard"
      />,
    );
    const chip = screen.getByTestId("chat-file-attachment-chip");
    expect(chip.textContent).toContain("…");
    expect(chip.textContent).toContain(".xlsx");
  });

  it("removes a chip with Delete and Backspace", () => {
    const onRemove = vi.fn();
    const path = "/Users/a/Projects/ADE/.ade/attachments/a.zip";
    render(
      <ChatAttachmentTray attachments={[{ path, type: "file" }]} mode="standard" onRemove={onRemove} />,
    );
    fireEvent.keyDown(screen.getByTestId("chat-file-attachment-chip"), { key: "Delete" });
    fireEvent.keyDown(screen.getByTestId("chat-file-attachment-chip"), { key: "Backspace" });
    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(onRemove).toHaveBeenCalledWith(path);
  });

  it("opens the preview popup on Enter and closes it on Escape", async () => {
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/Users/a/Projects/ADE/.ade/attachments/9f3a.csv", type: "file" }]}
        mode="standard"
      />,
    );
    fireEvent.keyDown(screen.getByTestId("chat-file-attachment-chip"), { key: "Enter" });

    const dialog = await screen.findByRole("dialog", { name: "9f3a.csv" });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "9f3a.csv" })).toBeNull());
  });

  it("closes the preview popup on a click outside", async () => {
    render(
      <ChatAttachmentTray
        attachments={[{ path: "/Users/a/Projects/ADE/.ade/attachments/9f3a.csv", type: "file" }]}
        mode="standard"
      />,
    );
    fireEvent.click(screen.getByTestId("chat-file-attachment-chip"));
    const dialog = await screen.findByRole("dialog", { name: "9f3a.csv" });
    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "9f3a.csv" })).toBeNull());
  });
});
