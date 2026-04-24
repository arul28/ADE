import { describe, expect, it } from "vitest";
import {
  isPrimaryPinnedIdentity,
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

  it("treats empty or whitespace-only agent suffixes as non-pinned", () => {
    expect(isPrimaryPinnedIdentity("cto")).toBe(true);
    expect(isPrimaryPinnedIdentity("agent:worker-1")).toBe(true);
    // Cast through unknown so the test can probe malformed identity keys that
    // ideally should never reach the helper but still could arrive via IPC.
    expect(isPrimaryPinnedIdentity("agent:" as never)).toBe(false);
    expect(isPrimaryPinnedIdentity("agent:   " as never)).toBe(false);
    expect(isPrimaryPinnedIdentity(undefined)).toBe(false);

    // Pinned-identity pathways should fall through to the guarded default for
    // malformed agent suffixes so a caller cannot smuggle full-auto in by
    // passing `agent:   `.
    expect(normalizeIdentityPermissionMode("agent:   " as never, undefined, "claude")).toBe("plan");
    expect(normalizeIdentityPermissionMode("agent:" as never, "plan", "codex")).toBe("plan");
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
