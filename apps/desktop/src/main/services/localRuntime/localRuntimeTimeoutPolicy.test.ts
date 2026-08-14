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
});
