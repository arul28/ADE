import { describe, expect, it } from "vitest";
import {
  isPrimaryPinnedIdentity,
  normalizeIdentityPermissionMode,
  resolveIdentityExecutionLane,
} from "./identitySessionPolicy";

describe("identitySessionPolicy", () => {
  it("forces CTO sessions into full-auto permission mode", () => {
    expect(normalizeIdentityPermissionMode("cto", "plan", "claude")).toBe("full-auto");
    expect(normalizeIdentityPermissionMode("cto", undefined, "codex")).toBe("full-auto");
  });

  it("pins CTO execution to the canonical lane", () => {
    expect(resolveIdentityExecutionLane("cto", "lane-feature", "lane-primary")).toBe("lane-primary");
  });

  it("falls back to plan/guarded mode for non-identity sessions", () => {
    expect(normalizeIdentityPermissionMode(undefined, "plan", "claude")).toBe("plan");
    expect(normalizeIdentityPermissionMode(undefined, "full-auto", "claude")).toBe("plan");
    expect(normalizeIdentityPermissionMode(undefined, undefined, "codex")).toBe("plan");
  });

  it("treats only the CTO identity as pinned", () => {
    expect(isPrimaryPinnedIdentity("cto")).toBe(true);
    // Cast through unknown so the test can probe malformed identity keys that
    // ideally should never reach the helper but still could arrive via IPC.
    expect(isPrimaryPinnedIdentity("agent:worker-1" as never)).toBe(false);
    expect(isPrimaryPinnedIdentity(undefined)).toBe(false);

    // Non-CTO identity pathways fall through to the guarded default so a caller
    // cannot smuggle full-auto in by passing a legacy `agent:` key.
    expect(normalizeIdentityPermissionMode("agent:worker-1" as never, undefined, "claude")).toBe("plan");
  });

  it("returns the canonical lane (including null) for pinned identities", () => {
    expect(resolveIdentityExecutionLane("cto", undefined, "lane-primary")).toBe("lane-primary");
    expect(resolveIdentityExecutionLane("cto", null, "lane-primary")).toBe("lane-primary");
    expect(resolveIdentityExecutionLane("cto", "lane-feature", null)).toBe(null);
  });

  it("passes through requested lanes for non-pinned identities", () => {
    expect(resolveIdentityExecutionLane("assistant" as never, "lane-feature", "lane-primary")).toBe("lane-feature");
    expect(resolveIdentityExecutionLane("assistant" as never, "  lane-feature  ", "lane-primary")).toBe("lane-feature");
    expect(resolveIdentityExecutionLane("assistant" as never, "   ", "lane-primary")).toBe(null);
  });
});
