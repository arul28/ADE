import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import { latestOpenableImageTarget, normalizeOpenableImageTarget } from "../imageTargets";

describe("normalizeOpenableImageTarget", () => {
  it("allows http and https URLs", () => {
    expect(normalizeOpenableImageTarget("https://example.test/image")).toBe(
      "https://example.test/image",
    );
    expect(normalizeOpenableImageTarget("http://example.test/image.png?sig=1")).toBe(
      "http://example.test/image.png?sig=1",
    );
  });

  it("allows absolute image file paths", () => {
    const target = path.resolve("proof.PNG");
    expect(normalizeOpenableImageTarget(target)).toBe(target);
  });

  it("rejects data URLs, file URLs, relative paths, and executable names", () => {
    expect(normalizeOpenableImageTarget("data:image/png;base64,AAAA")).toBeNull();
    expect(normalizeOpenableImageTarget("file:///tmp/proof.png")).toBeNull();
    expect(normalizeOpenableImageTarget("proof.png")).toBeNull();
    expect(normalizeOpenableImageTarget("calc.exe")).toBeNull();
  });

  it("rejects absolute non-image file paths", () => {
    expect(normalizeOpenableImageTarget(path.resolve("notes.txt"))).toBeNull();
  });
});

describe("latestOpenableImageTarget", () => {
  const envelope = (
    sequence: number,
    event: AgentChatEventEnvelope["event"],
  ): AgentChatEventEnvelope => ({
    sequence,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    sessionId: "session-1",
    event,
  });

  it("prefers saved image files over base64 generation results", () => {
    const savedPath = path.resolve("generated.png");
    expect(latestOpenableImageTarget([
      envelope(1, {
        type: "codex_image_generation",
        result: "data:image/png;base64,AAAA",
        savedPath,
      } as AgentChatEventEnvelope["event"]),
    ])).toBe(savedPath);
  });

  it("falls back to openable result URLs for generated images", () => {
    expect(latestOpenableImageTarget([
      envelope(1, {
        type: "codex_image_generation",
        result: "https://example.test/generated.png",
      } as AgentChatEventEnvelope["event"]),
    ])).toBe("https://example.test/generated.png");
  });

  it("walks backward through recent image events", () => {
    const olderPath = path.resolve("older.png");
    expect(latestOpenableImageTarget([
      envelope(1, { type: "codex_image_view", path: olderPath } as AgentChatEventEnvelope["event"]),
      envelope(2, {
        type: "codex_image_generation",
        result: "data:image/png;base64,AAAA",
      } as AgentChatEventEnvelope["event"]),
    ])).toBe(olderPath);
  });
});
