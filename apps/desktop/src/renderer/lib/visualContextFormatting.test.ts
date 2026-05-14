import { describe, expect, it } from "vitest";
import { shouldAttachAutomaticMacosVmContext } from "./visualContextFormatting";

describe("shouldAttachAutomaticMacosVmContext", () => {
  it("attaches only for ADE macOS VM prompts", () => {
    expect(shouldAttachAutomaticMacosVmContext("Use the ADE macOS VM for this lane.")).toBe(true);
    expect(shouldAttachAutomaticMacosVmContext("Please validate in the ADE VM.")).toBe(true);
    expect(shouldAttachAutomaticMacosVmContext("Open an isolated mac GUI and inspect the app.")).toBe(true);
    expect(shouldAttachAutomaticMacosVmContext("Use lume for this check.")).toBe(true);
  });

  it("does not attach for unrelated virtual-machine phrasing", () => {
    expect(shouldAttachAutomaticMacosVmContext("Check whether Docker VM networking is healthy.")).toBe(false);
    expect(shouldAttachAutomaticMacosVmContext("The CI VM has low disk space.")).toBe(false);
  });
});
