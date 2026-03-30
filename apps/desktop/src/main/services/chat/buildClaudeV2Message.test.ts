import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatFileRef } from "../../../shared/types/chat";
import {
  buildClaudeV2Message,
  ANTHROPIC_IMAGE_MEDIA_TYPES,
  inferAttachmentMediaType,
  type SDKUserMessagePartial,
} from "./buildClaudeV2Message";

describe("buildClaudeV2Message", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-v2-msg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Helper to create a real image file on disk ──
  function writeFakeImage(name: string, content = "fake-image-bytes"): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. No attachments -> plain string
  // ─────────────────────────────────────────────────────────────────────────
  it("returns plain string when there are no attachments", () => {
    const result = buildClaudeV2Message("Hello, Claude!", []);
    expect(result).toBe("Hello, Claude!");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Non-image attachments -> string with file hints
  // ─────────────────────────────────────────────────────────────────────────
  it("returns string with file hints for non-image attachments", () => {
    const attachments: AgentChatFileRef[] = [
      { path: "/some/dir/data.csv", type: "file" },
      { path: "/some/dir/script.py", type: "file" },
    ];
    const result = buildClaudeV2Message("Analyze these files", attachments);
    expect(typeof result).toBe("string");
    expect(result).toContain("Analyze these files");
    expect(result).toContain("[File attached: /some/dir/data.csv]");
    expect(result).toContain("[File attached: /some/dir/script.py]");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Image attachments -> SDKUserMessage with base64 content blocks
  // ─────────────────────────────────────────────────────────────────────────
  it("returns SDKUserMessage with base64 image blocks for valid images", () => {
    const imgPath = writeFakeImage("photo.png");
    const attachments: AgentChatFileRef[] = [
      { path: imgPath, type: "image" },
    ];

    const result = buildClaudeV2Message("Describe this image", attachments);

    // Should be an object, not a string
    expect(typeof result).toBe("object");
    const msg = result as SDKUserMessagePartial;
    expect(msg.type).toBe("user");
    expect(msg.message.role).toBe("user");

    // Should have two content blocks: text + image
    const content = msg.message.content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "Describe this image" });

    // Image block should have base64-encoded data
    const imgBlock = content[1] as Record<string, unknown>;
    expect(imgBlock.type).toBe("image");
    const source = imgBlock.source as Record<string, unknown>;
    expect(source.type).toBe("base64");
    expect(source.media_type).toBe("image/png");
    expect(typeof source.data).toBe("string");
    // Verify the base64 decodes to the original content
    expect(Buffer.from(source.data as string, "base64").toString()).toBe("fake-image-bytes");
  });

  it("resolves relative image attachments against the provided base directory", () => {
    writeFakeImage("relative-photo.png");
    const attachments: AgentChatFileRef[] = [
      { path: "relative-photo.png", type: "image" },
    ];

    const result = buildClaudeV2Message("Describe this image", attachments, { baseDir: tmpDir });
    const msg = result as SDKUserMessagePartial;
    const imgBlock = msg.message.content[1] as Record<string, unknown>;
    const source = imgBlock.source as Record<string, unknown>;

    expect(Buffer.from(source.data as string, "base64").toString()).toBe("fake-image-bytes");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Missing image file -> text fallback
  // ─────────────────────────────────────────────────────────────────────────
  it("handles missing image files gracefully with text fallback", () => {
    const attachments: AgentChatFileRef[] = [
      { path: "/nonexistent/path/missing.png", type: "image" },
    ];

    const result = buildClaudeV2Message("Look at this", attachments);

    expect(typeof result).toBe("object");
    const msg = result as SDKUserMessagePartial;
    const content = msg.message.content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "Look at this" });
    // After TOCTOU fix, missing files go through the catch path
    const fallback = content[1] as Record<string, unknown>;
    expect(fallback.type).toBe("text");
    expect((fallback.text as string)).toContain("[Image unavailable: /nonexistent/path/missing.png");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Unsupported MIME type -> text fallback with media type
  // ─────────────────────────────────────────────────────────────────────────
  it("handles unsupported MIME types gracefully", () => {
    // .svg resolves to "image/svg+xml" which is NOT in ANTHROPIC_IMAGE_MEDIA_TYPES
    const svgPath = writeFakeImage("diagram.svg");
    const attachments: AgentChatFileRef[] = [
      { path: svgPath, type: "image" },
    ];

    const result = buildClaudeV2Message("Check this diagram", attachments);

    expect(typeof result).toBe("object");
    const msg = result as SDKUserMessagePartial;
    const content = msg.message.content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "Check this diagram" });
    expect(content[1]).toEqual({
      type: "text",
      text: `\n[Image attached (image/svg+xml): ${svgPath}]`,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Mixed image and non-image attachments
  // ─────────────────────────────────────────────────────────────────────────
  it("handles mixed image and non-image attachments", () => {
    const pngPath = writeFakeImage("screenshot.png");
    const attachments: AgentChatFileRef[] = [
      { path: "/workspace/readme.md", type: "file" },
      { path: pngPath, type: "image" },
      { path: "/workspace/config.json", type: "file" },
    ];

    const result = buildClaudeV2Message("Review these", attachments);

    expect(typeof result).toBe("object");
    const msg = result as SDKUserMessagePartial;
    const content = msg.message.content;

    // 4 blocks: prompt text + file hint + image + file hint
    expect(content).toHaveLength(4);

    // First block: prompt text
    expect(content[0]).toEqual({ type: "text", text: "Review these" });

    // Second block: non-image file hint
    expect(content[1]).toEqual({
      type: "text",
      text: "\n[File attached: /workspace/readme.md]",
    });

    // Third block: base64 image
    const imgBlock = content[2] as Record<string, unknown>;
    expect(imgBlock.type).toBe("image");
    const source = imgBlock.source as Record<string, unknown>;
    expect(source.type).toBe("base64");
    expect(source.media_type).toBe("image/png");

    // Fourth block: non-image file hint
    expect(content[3]).toEqual({
      type: "text",
      text: "\n[File attached: /workspace/config.json]",
    });
  });
});

describe("inferAttachmentMediaType", () => {
  it("returns correct MIME type for known image extensions", () => {
    expect(inferAttachmentMediaType({ path: "photo.jpg", type: "image" })).toBe("image/jpeg");
    expect(inferAttachmentMediaType({ path: "photo.jpeg", type: "image" })).toBe("image/jpeg");
    expect(inferAttachmentMediaType({ path: "photo.png", type: "image" })).toBe("image/png");
    expect(inferAttachmentMediaType({ path: "photo.gif", type: "image" })).toBe("image/gif");
    expect(inferAttachmentMediaType({ path: "photo.webp", type: "image" })).toBe("image/webp");
  });

  it("returns correct MIME type for known non-image extensions", () => {
    expect(inferAttachmentMediaType({ path: "data.json", type: "file" })).toBe("application/json");
    expect(inferAttachmentMediaType({ path: "style.css", type: "file" })).toBe("text/css");
    expect(inferAttachmentMediaType({ path: "main.ts", type: "file" })).toBe("text/typescript");
  });

  it("defaults to image/png for unknown extensions on image attachments", () => {
    expect(inferAttachmentMediaType({ path: "photo.bmp", type: "image" })).toBe("image/png");
  });

  it("defaults to application/octet-stream for unknown extensions on file attachments", () => {
    expect(inferAttachmentMediaType({ path: "data.xyz", type: "file" })).toBe("application/octet-stream");
  });
});

describe("ANTHROPIC_IMAGE_MEDIA_TYPES", () => {
  it("contains exactly the four supported image types", () => {
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.has("image/jpeg")).toBe(true);
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.has("image/png")).toBe(true);
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.has("image/gif")).toBe(true);
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.has("image/webp")).toBe(true);
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.size).toBe(4);
  });

  it("does not contain SVG or other image types", () => {
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.has("image/svg+xml")).toBe(false);
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.has("image/bmp")).toBe(false);
    expect(ANTHROPIC_IMAGE_MEDIA_TYPES.has("image/tiff")).toBe(false);
  });
});
