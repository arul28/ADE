import { describe, expect, it } from "vitest";
import {
  beginIdentityReadOnlyHold,
  isIdentityReadOnlyHeld,
  isPrimaryPinnedIdentity,
  normalizeIdentityPermissionMode,
  resolveIdentityExecutionLane,
} from "./identitySessionPolicy";

describe("identitySessionPolicy", () => {
  it("forces CTO sessions into full-auto permission mode", () => {
    expect(normalizeIdentityPermissionMode("cto", "plan", "claude")).toBe("full-auto");
    expect(normalizeIdentityPermissionMode("cto", undefined, "codex")).toBe("full-auto");
  });

  it("holds the CTO read-only while a voice call is up", () => {
    // The whole safety story for voice rests on this. Without the hold the CTO
    // is full-auto, and `updateSession({permissionMode:"plan"})` is discarded
    // by this very function — so a misheard sentence reaches a tool that writes.
    expect(normalizeIdentityPermissionMode("cto", "plan", "claude")).toBe("full-auto");
    const release = beginIdentityReadOnlyHold();
    try {
      expect(isIdentityReadOnlyHeld()).toBe(true);
      // Read-only wins over every requested mode, including the full-auto that
      // `ensureIdentitySession` re-normalizes with before each turn.
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("plan");
      expect(normalizeIdentityPermissionMode("cto", undefined, "codex")).toBe("plan");
    } finally {
      release();
    }
    expect(isIdentityReadOnlyHeld()).toBe(false);
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("full-auto");
  });

  it("needs every hold released before the CTO can write again", () => {
    const first = beginIdentityReadOnlyHold();
    const second = beginIdentityReadOnlyHold();
    first();
    // A second call still running must not be let out by the first hanging up.
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("plan");
    // Releasing twice must not credit the counter for a hold nobody took.
    first();
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("plan");
    second();
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("full-auto");
  });

  it("leaves non-CTO identities untouched by a hold", () => {
    // The contrast is the test. A non-identity session already answers "plan",
    // so asserting only the held value proves nothing — it would pass even if
    // the hold were ignored entirely. What must hold is that the hold changes
    // the CTO's answer and leaves everyone else's exactly as it was.
    const ctoBefore = normalizeIdentityPermissionMode("cto", "full-auto", "claude");
    const otherBefore = normalizeIdentityPermissionMode(undefined, "full-auto", "claude");
    const release = beginIdentityReadOnlyHold();
    try {
      expect(normalizeIdentityPermissionMode(undefined, "full-auto", "claude")).toBe(otherBefore);
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).not.toBe(ctoBefore);
      // Not merely "different" — a mutation answering "edit" would pass that.
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("plan");
    } finally {
      release();
    }
  });

  it("refuses to let a held CTO leave plan mode", () => {
    // This is what `exitPlanModeForSession` reports to its callers: approving a
    // plan card mid-call must not announce an exit, and must not tell the live
    // query the session is writable again.
    const release = beginIdentityReadOnlyHold();
    try {
      // Whatever an exit path asks for, the policy answers "plan".
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("plan");
      expect(normalizeIdentityPermissionMode("cto", "edit", "claude")).toBe("plan");
    } finally {
      release();
    }
    // And once the call is over, the same request is honoured.
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("full-auto");
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
