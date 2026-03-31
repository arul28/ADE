import { describe, expect, it } from "vitest";
import { revealLabel } from "./platform";

describe("platform detection", () => {
  it("exports revealLabel as a non-empty string", () => {
    expect(typeof revealLabel).toBe("string");
    expect(revealLabel.length).toBeGreaterThan(0);
  });

  it("returns the correct label for the current platform", () => {
    // In vitest (node environment), navigator is typically undefined,
    // so the module falls back to process.platform.
    // On macOS (darwin), it should detect as Mac.
    const expectMac =
      typeof process !== "undefined" &&
      typeof process.platform === "string" &&
      process.platform === "darwin";

    if (expectMac) {
      expect(revealLabel).toBe("Reveal in Finder");
    } else {
      expect(revealLabel).toBe("Reveal in File Explorer");
    }
  });

  it("label is one of the two known values", () => {
    expect(["Reveal in Finder", "Reveal in File Explorer"]).toContain(revealLabel);
  });
});
