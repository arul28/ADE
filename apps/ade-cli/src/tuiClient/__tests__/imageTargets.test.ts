import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeOpenableImageTarget } from "../imageTargets";

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
