import { describe, expect, it } from "vitest";
import { mapOpenCodeImagePart } from "./openCodeStructuredActivity";

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
