import { describe, expect, it } from "vitest";
import { localRuntimeActionTimeoutMs } from "./localRuntimeTimeoutPolicy";

describe("localRuntimeActionTimeoutMs", () => {
  it("gives Cursor Cloud open-chat the same long budget as handoff", () => {
    expect(localRuntimeActionTimeoutMs("ai", "openCursorCloudChat")).toBe(120_000);
    expect(localRuntimeActionTimeoutMs("ai", "createCursorCloudRun")).toBe(120_000);
    expect(localRuntimeActionTimeoutMs("chat", "handoffSession")).toBe(120_000);
  });

  it("keeps the default 30s budget for ordinary actions", () => {
    expect(localRuntimeActionTimeoutMs("ai", "listCursorCloudAgents")).toBe(30_000);
  });

  it("outlives a cold simulator launch and a preview build", () => {
    // boot (90s) + xcodebuild (600s) + install (180s) + launch (60s) = 930s
    // all run inside one daemon action, so the budget must exceed that sum.
    // At the 30s default the renderer reported "Remote ADE service timed out"
    // while the build kept going.
    expect(localRuntimeActionTimeoutMs("ios_simulator", "launch")).toBe(17 * 60_000);
    for (const action of ["renderPreview", "renderCurrentPreview", "ensurePreviewWorkspace"]) {
      expect(localRuntimeActionTimeoutMs("ios_simulator", action)).toBe(10 * 60_000);
    }
  });

  it("leaves cheap simulator actions on the default budget", () => {
    expect(localRuntimeActionTimeoutMs("ios_simulator", "tap")).toBe(30_000);
    expect(localRuntimeActionTimeoutMs("ios_simulator", "getStatus")).toBe(30_000);
  });
});
