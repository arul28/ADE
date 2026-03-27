import { describe, expect, it } from "vitest";
import { inferAttachmentType, mergeAttachments, type AgentChatFileRef } from "./chat";

describe("inferAttachmentType", () => {
  it("returns 'image' for image MIME types", () => {
    expect(inferAttachmentType("file.bin", "image/png")).toBe("image");
    expect(inferAttachmentType("file.bin", "image/jpeg")).toBe("image");
    expect(inferAttachmentType("file.bin", "image/webp")).toBe("image");
    expect(inferAttachmentType("file.bin", "image/svg+xml")).toBe("image");
  });

  it("returns 'image' for image file extensions when no mimeType is provided", () => {
    expect(inferAttachmentType("photo.png")).toBe("image");
    expect(inferAttachmentType("photo.PNG")).toBe("image");
    expect(inferAttachmentType("photo.jpg")).toBe("image");
    expect(inferAttachmentType("photo.jpeg")).toBe("image");
    expect(inferAttachmentType("photo.gif")).toBe("image");
    expect(inferAttachmentType("photo.webp")).toBe("image");
    expect(inferAttachmentType("photo.bmp")).toBe("image");
    expect(inferAttachmentType("photo.svg")).toBe("image");
    expect(inferAttachmentType("photo.ico")).toBe("image");
    expect(inferAttachmentType("photo.tiff")).toBe("image");
    expect(inferAttachmentType("photo.tif")).toBe("image");
  });

  it("returns 'file' for non-image extensions and no image mimeType", () => {
    expect(inferAttachmentType("doc.pdf")).toBe("file");
    expect(inferAttachmentType("code.ts")).toBe("file");
    expect(inferAttachmentType("archive.zip")).toBe("file");
    expect(inferAttachmentType("readme.md")).toBe("file");
    expect(inferAttachmentType("data.json")).toBe("file");
  });

  it("falls through to extension check when MIME type is non-image", () => {
    // Non-image MIME type does not block the extension check
    expect(inferAttachmentType("fake.png", "application/octet-stream")).toBe("image");
    expect(inferAttachmentType("file.txt", "application/octet-stream")).toBe("file");
  });

  it("image MIME type overrides non-image extension", () => {
    expect(inferAttachmentType("file.txt", "image/png")).toBe("image");
    // Non-image MIME + image extension still matches by extension
    expect(inferAttachmentType("photo.png", "text/plain")).toBe("image");
  });

  it("handles null/undefined mimeType gracefully", () => {
    expect(inferAttachmentType("file.ts", null)).toBe("file");
    expect(inferAttachmentType("photo.jpg", null)).toBe("image");
    expect(inferAttachmentType("file.ts", undefined)).toBe("file");
  });
});

describe("mergeAttachments", () => {
  it("merges two lists deduplicating by path (last-write wins)", () => {
    const current: AgentChatFileRef[] = [
      { path: "/a.ts", type: "file" },
      { path: "/b.png", type: "image" },
    ];
    const incoming: AgentChatFileRef[] = [
      { path: "/b.png", type: "file" }, // overrides: same path, different type
      { path: "/c.md", type: "file" },
    ];

    const result = mergeAttachments(current, incoming);
    expect(result).toHaveLength(3);
    expect(result.find((a) => a.path === "/b.png")!.type).toBe("file"); // last-write wins
    expect(result.find((a) => a.path === "/c.md")).toBeTruthy();
  });

  it("filters out incoming entries with empty paths", () => {
    const current: AgentChatFileRef[] = [{ path: "/a.ts", type: "file" }];
    const incoming: AgentChatFileRef[] = [
      { path: "", type: "file" },
      { path: "  ", type: "image" },
      { path: "/b.ts", type: "file" },
    ];

    const result = mergeAttachments(current, incoming);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.path)).toEqual(["/a.ts", "/b.ts"]);
  });

  it("returns empty array when both inputs are empty", () => {
    expect(mergeAttachments([], [])).toEqual([]);
  });

  it("returns current when incoming is empty", () => {
    const current: AgentChatFileRef[] = [{ path: "/a.ts", type: "file" }];
    const result = mergeAttachments(current, []);
    expect(result).toEqual(current);
  });

  it("returns incoming when current is empty (filtering empty paths)", () => {
    const incoming: AgentChatFileRef[] = [{ path: "/a.ts", type: "file" }];
    const result = mergeAttachments([], incoming);
    expect(result).toEqual(incoming);
  });

  it("preserves order: current first, then new incoming entries", () => {
    const current: AgentChatFileRef[] = [
      { path: "/first.ts", type: "file" },
      { path: "/second.ts", type: "file" },
    ];
    const incoming: AgentChatFileRef[] = [
      { path: "/third.ts", type: "file" },
    ];

    const result = mergeAttachments(current, incoming);
    expect(result.map((a) => a.path)).toEqual(["/first.ts", "/second.ts", "/third.ts"]);
  });
});
