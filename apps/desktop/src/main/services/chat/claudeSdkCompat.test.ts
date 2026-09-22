import { describe, expect, it } from "vitest";
import { claudePluginDeliveryForSource } from "./claudeSdkCompat";

describe("claudePluginDeliveryForSource", () => {
  it("delivers plugins over stdin for ADE-managed binaries", () => {
    expect(claudePluginDeliveryForSource("bundled")).toBe("initialize");
    expect(claudePluginDeliveryForSource("tools-cache")).toBe("initialize");
  });

  it("keeps argv delivery for binaries whose version ADE does not control", () => {
    for (const source of ["env", "auth", "path", "common-dir", "fallback-command"] as const) {
      expect(claudePluginDeliveryForSource(source)).toBeNull();
    }
  });
});
