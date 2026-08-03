import { describe, expect, it } from "vitest";
import { microphonePermissionGuidance } from "./microphonePermissionGuidance";

describe("microphonePermissionGuidance", () => {
  it("points Windows users to both Win32 microphone privacy switches", () => {
    const message = microphonePermissionGuidance("win32");
    expect(message).toContain("Settings → Privacy & security → Microphone");
    expect(message).toContain("Let desktop apps access your microphone");
  });

  it("keeps the macOS System Settings guidance", () => {
    expect(microphonePermissionGuidance("darwin")).toContain(
      "System Settings → Privacy & Security → Microphone",
    );
  });
});
