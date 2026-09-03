import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentTray,
  FileAttachmentChip,
  ImageAttachmentPreview,
  IssueAttachmentChip,
  OrchestrationAnnotationChip,
  attachmentChipTone,
  attachmentName,
  middleTruncateFilename,
} from "../src/attachments";

afterEach(cleanup);

const BRAND = {
  borderSubtle: "rgba(94, 106, 210, 0.20)",
  surface: "rgba(94, 106, 210, 0.10)",
  surfaceHover: "rgba(94, 106, 210, 0.16)",
  text: "#C7CDF5",
  textMuted: "rgba(199, 205, 245, 0.65)",
  primaryBright: "#7B8AF0",
};

describe("filename helpers", () => {
  it("keeps the head and the extension when eliding the middle", () => {
    const name = "quarterly-revenue-breakdown-final-v7.spreadsheet";
    const truncated = middleTruncateFilename(name);
    expect(truncated.length).toBeLessThan(name.length);
    expect(truncated).toContain("…");
    expect(truncated.startsWith("quarterly")).toBe(true);
    expect(truncated.endsWith("spreadsheet")).toBe(true);
    expect(middleTruncateFilename("short.txt")).toBe("short.txt");
  });

  it("takes the last segment of POSIX and Windows paths", () => {
    expect(attachmentName("/a/b/c.png")).toBe("c.png");
    expect(attachmentName("C:\\Users\\foo\\bar.png")).toBe("bar.png");
  });
});

describe("attachmentChipTone", () => {
  it("returns the compiled tray's tone strings", () => {
    expect(attachmentChipTone("resolver")).toBe(
      "border-orange-400/18 bg-orange-500/10 text-orange-100",
    );
    expect(attachmentChipTone("default")).toContain("var(--chat-accent)");
  });
});

describe("AttachmentTray", () => {
  it("marks itself as the focus root the chips walk", () => {
    render(
      <AttachmentTray className="mt-2">
        <span>child</span>
      </AttachmentTray>,
    );
    const root = document.querySelector("[data-chat-attachment-tray='true']");
    expect(root).toBeTruthy();
    expect(root?.className).toContain("flex-wrap");
    expect(root?.className).toContain("mt-2");
    expect(screen.getByText("child")).toBeTruthy();
  });
});

describe("FileAttachmentChip", () => {
  it("opens on Enter", () => {
    const onOpen = vi.fn();
    render(<FileAttachmentChip name="notes.md" toneClassName="tone" onOpen={onOpen} />);
    const chip = screen.getByTestId("chat-file-attachment-chip");
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("removes on Backspace without opening", () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <AttachmentTray>
        <FileAttachmentChip name="notes.md" toneClassName="tone" onOpen={onOpen} onRemove={onRemove} />
      </AttachmentTray>,
    );
    fireEvent.keyDown(screen.getByTestId("chat-file-attachment-chip"), { key: "Backspace" });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows the size label only when the caller knows it", () => {
    const { rerender } = render(<FileAttachmentChip name="notes.md" toneClassName="tone" />);
    expect(screen.queryByText("12 KB")).toBeNull();
    rerender(<FileAttachmentChip name="notes.md" sizeLabel="12 KB" toneClassName="tone" />);
    expect(screen.getByText("12 KB")).toBeTruthy();
  });
});

describe("ImageAttachmentPreview", () => {
  it("titles the copy button 'Copied' once the copy resolves", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(<ImageAttachmentPreview name="shot.png" toneClassName="tone" onCopy={onCopy} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy shot.png" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy shot.png" }).getAttribute("title")).toBe("Copied"),
    );
  });

  it("titles it 'Copy failed' when the copy rejects", async () => {
    const onCopy = vi.fn().mockRejectedValue(new Error("clipboard"));
    render(<ImageAttachmentPreview name="shot.png" toneClassName="tone" onCopy={onCopy} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy shot.png" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy shot.png" }).getAttribute("title")).toBe(
        "Copy failed",
      ),
    );
  });

  it("draws no copy button when the host offers no clipboard", () => {
    render(<ImageAttachmentPreview name="shot.png" toneClassName="tone" />);
    expect(screen.queryByRole("button", { name: "Copy shot.png" })).toBeNull();
  });

  it("shows the 'No preview' badge instead of an image when the read failed", () => {
    render(<ImageAttachmentPreview name="shot.png" toneClassName="tone" previewFailed />);
    expect(screen.getByText("No preview")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("IssueAttachmentChip", () => {
  it("removes without opening", () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <IssueAttachmentChip
        identifier="ADE-125"
        title="Settled lifecycle"
        brand={BRAND}
        glyph={<span>L</span>}
        testId="linear-issue-context-chip"
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove ADE-125" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens when the chip body is clicked, and shows the secondary label", () => {
    const onOpen = vi.fn();
    render(
      <IssueAttachmentChip
        identifier="ADE-125"
        title="Settled lifecycle"
        secondaryLabel="Platform"
        brand={BRAND}
        glyph={<span>L</span>}
        testId="linear-issue-context-chip"
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("Platform")).toBeTruthy();
    fireEvent.click(screen.getByTestId("linear-issue-context-chip"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("OrchestrationAnnotationChip", () => {
  it("prefers the comment over the anchor preview", () => {
    render(
      <OrchestrationAnnotationChip anchorKind="file" comment="  tighten this  " preview="const x = 1" />,
    );
    const chip = screen.getByTestId("orchestration-annotation-context-chip");
    expect(chip.textContent).toContain("tighten this");
    expect(chip.getAttribute("title")).toBe("Annotation (file) — tighten this");
  });

  it("falls back to the preview, then to a placeholder", () => {
    const { rerender } = render(
      <OrchestrationAnnotationChip anchorKind="file" comment="" preview="const x = 1" />,
    );
    expect(screen.getByTestId("orchestration-annotation-context-chip").textContent).toContain(
      "const x = 1",
    );
    rerender(<OrchestrationAnnotationChip anchorKind="file" comment="" preview="" />);
    expect(screen.getByText("(no comment)")).toBeTruthy();
  });
});
