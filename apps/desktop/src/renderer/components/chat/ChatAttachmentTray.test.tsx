/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatAttachmentTray } from "./ChatAttachmentTray";

describe("ChatAttachmentTray", () => {
  const getImageDataUrl = vi.fn();
  const writeClipboardImage = vi.fn();

  beforeEach(() => {
    getImageDataUrl.mockResolvedValue({ dataUrl: "data:image/png;base64,abc123" });
    writeClipboardImage.mockResolvedValue(undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        app: {
          getImageDataUrl,
          writeClipboardImage,
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

    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledWith("/tmp/screenshot.png"));

    const openButton = screen.getByRole("button", { name: "Open screenshot.png" });
    expect(screen.getByAltText("screenshot.png").getAttribute("src")).toBe("data:image/png;base64,abc123");

    fireEvent.click(openButton);

    expect(screen.getByRole("dialog", { name: "screenshot.png" })).toBeTruthy();
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
});
