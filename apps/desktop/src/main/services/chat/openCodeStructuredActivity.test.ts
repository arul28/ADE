import { describe, expect, it } from "vitest";
import {
  isOpenCodeImageGenerationToolName,
  mapOpenCodeImageAttachment,
  mapOpenCodeImagePart,
} from "./openCodeStructuredActivity";

describe("mapOpenCodeImagePart", () => {
  it("maps remote image file parts to the shared image output card", () => {
    const emittedPartIds = new Set<string>();
    expect(mapOpenCodeImagePart({
      part: {
        id: "image-1",
        type: "file",
        mime: "image/png",
        filename: "moon.png",
        url: "https://cdn.example.com/moon.png",
      },
      turnId: "turn-1",
      emittedPartIds,
    })).toEqual({
      type: "codex_image_generation",
      itemId: "image-1",
      turnId: "turn-1",
      prompt: "moon.png",
      result: "https://cdn.example.com/moon.png",
      status: "completed",
    });
  });

  it("retains a local path for desktop open and TUI image targeting", () => {
    expect(mapOpenCodeImagePart({
      part: {
        id: "image-2",
        type: "file",
        mime: "image/webp",
        url: "file:///tmp/generated%20image.webp",
      },
      turnId: "turn-1",
      emittedPartIds: new Set(),
    })).toEqual(expect.objectContaining({
      result: "file:///tmp/generated%20image.webp",
      savedPath: "/tmp/generated image.webp",
      status: "completed",
    }));
  });

  it("dedupes the same file surfaced as a part and tool attachment", () => {
    const emittedPartIds = new Set<string>();
    const part = {
      id: "image-3",
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,AAAA",
    };
    expect(mapOpenCodeImagePart({ part, turnId: "turn-1", emittedPartIds })).not.toBeNull();
    expect(mapOpenCodeImagePart({ part, turnId: "turn-1", emittedPartIds })).toBeNull();
  });

  it("ignores non-image and malformed file parts", () => {
    const emittedPartIds = new Set<string>();
    expect(mapOpenCodeImagePart({
      part: { id: "file-1", type: "file", mime: "application/pdf", url: "/tmp/a.pdf" },
      turnId: "turn-1",
      emittedPartIds,
    })).toBeNull();
    expect(mapOpenCodeImagePart({
      part: { type: "file", mime: "image/png" },
      turnId: "turn-1",
      emittedPartIds,
    })).toBeNull();
  });
});

describe("mapOpenCodeImageAttachment", () => {
  it("maps a tool-returned image to the viewing line, never a generation", () => {
    const emittedPartIds = new Set<string>();
    expect(mapOpenCodeImageAttachment({
      part: {
        id: "attach-1",
        type: "file",
        mime: "image/png",
        filename: "Screenshot 2026-09-18.png",
        url: "data:image/png;base64,AAAA",
      },
      turnId: "turn-1",
      emittedPartIds,
    })).toEqual({
      type: "codex_image_view",
      itemId: "attach-1",
      turnId: "turn-1",
      title: "Screenshot 2026-09-18.png",
      url: "data:image/png;base64,AAAA",
      status: "completed",
    });
  });

  it("carries a file:// attachment as a local path for open", () => {
    expect(mapOpenCodeImageAttachment({
      part: {
        id: "attach-2",
        type: "file",
        mime: "image/jpeg",
        url: "file:///tmp/pasted%20photo.jpg",
      },
      turnId: "turn-1",
      emittedPartIds: new Set(),
    })).toEqual(expect.objectContaining({
      path: "/tmp/pasted photo.jpg",
      title: "pasted photo.jpg",
      status: "completed",
    }));
  });

  it("falls back to a generic title when the attachment is unnamed", () => {
    const view = mapOpenCodeImageAttachment({
      part: { id: "attach-3", type: "file", mime: "image/png", url: "https://cdn.example.com/a.png" },
      turnId: "turn-1",
      emittedPartIds: new Set(),
    });
    expect(view?.title).toBeUndefined();
    expect(view?.url).toBe("https://cdn.example.com/a.png");
  });

  it("shares the dedupe set with generated images", () => {
    const emittedPartIds = new Set<string>();
    const part = { id: "shared-1", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" };
    expect(mapOpenCodeImageAttachment({ part, turnId: "turn-1", emittedPartIds })).not.toBeNull();
    expect(mapOpenCodeImagePart({ part, turnId: "turn-1", emittedPartIds })).toBeNull();
  });

  it("ignores non-image and malformed parts", () => {
    const emittedPartIds = new Set<string>();
    expect(mapOpenCodeImageAttachment({
      part: { id: "attach-4", type: "file", mime: "text/plain", url: "/tmp/a.txt" },
      turnId: "turn-1",
      emittedPartIds,
    })).toBeNull();
    expect(mapOpenCodeImageAttachment({
      part: { type: "file", mime: "image/png" },
      turnId: "turn-1",
      emittedPartIds,
    })).toBeNull();
  });
});

describe("isOpenCodeImageGenerationToolName", () => {
  it("recognizes media-producing tool names", () => {
    for (const tool of ["generate_image", "image_generation", "imagegen", "draw_image", "create_image", "render-picture"]) {
      expect(isOpenCodeImageGenerationToolName(tool), tool).toBe(true);
    }
  });

  it("treats readers and unknown tools as views, never generations", () => {
    for (const tool of [
      "read",
      "bash",
      "webfetch",
      "screenshot",
      "browser_screenshot",
      "figma_get_image",
      // `art` must end the token: these return files, they do not paint them.
      "create_article",
      "render_article",
      "generate_artifacts",
      "generate_images",
      null,
      undefined,
    ]) {
      expect(isOpenCodeImageGenerationToolName(tool), String(tool)).toBe(false);
    }
  });
});
