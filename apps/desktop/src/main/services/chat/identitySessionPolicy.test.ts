import { describe, expect, it } from "vitest";
import {
  normalizeIdentityPermissionMode,
  resolveIdentityExecutionLane,
} from "./identitySessionPolicy";

describe("identitySessionPolicy", () => {
  it("forces CTO and worker sessions into full-auto permission mode", () => {
    expect(normalizeIdentityPermissionMode("cto", "plan", "claude")).toBe("full-auto");
    expect(normalizeIdentityPermissionMode("cto", undefined, "codex")).toBe("full-auto");
    expect(normalizeIdentityPermissionMode("agent:worker-1", undefined, "codex")).toBe("full-auto");
    expect(normalizeIdentityPermissionMode("agent:worker-1", "plan", "claude")).toBe("full-auto");
  });

  it("pins CTO and worker execution to the canonical lane", () => {
    expect(resolveIdentityExecutionLane("cto", "lane-feature", "lane-primary")).toBe("lane-primary");
    expect(resolveIdentityExecutionLane("agent:worker-1", "lane-feature", "lane-primary")).toBe("lane-primary");
  });

  it("falls back to plan/guarded mode for non-identity sessions", () => {
    expect(normalizeIdentityPermissionMode(undefined, "plan", "claude")).toBe("plan");
    expect(normalizeIdentityPermissionMode(undefined, "full-auto", "claude")).toBe("plan");
    expect(normalizeIdentityPermissionMode(undefined, undefined, "codex")).toBe("plan");
  });
});
