import { describe, expect, it } from "vitest";
import {
  beginIdentityConfirmHold,
  isIdentityConfirmHeld,
  isPrimaryPinnedIdentity,
  normalizeIdentityPermissionMode,
  resolveIdentityExecutionLane,
} from "./identitySessionPolicy";

describe("identitySessionPolicy", () => {
  it("forces CTO sessions into full-auto permission mode", () => {
    expect(normalizeIdentityPermissionMode("cto", "plan", "claude")).toBe("full-auto");
    expect(normalizeIdentityPermissionMode("cto", undefined, "codex")).toBe("full-auto");
  });

  it("makes the CTO ask before it writes while a voice call is up", () => {
    // The whole safety story for voice rests on this. Without the hold the CTO
    // is full-auto, and a mode written onto the session is discarded by this
    // very function — so a misheard sentence reaches a tool that writes with
    // nobody asked. `default` is the mode where reads run free and mutations
    // raise an approval; see `claudeToolNeedsApproval`.
    expect(normalizeIdentityPermissionMode("cto", "plan", "claude")).toBe("full-auto");
    const release = beginIdentityConfirmHold();
    try {
      expect(isIdentityConfirmHeld()).toBe(true);
      // Confirm-first wins over every requested mode, including the full-auto
      // that `ensureIdentitySession` re-normalizes with before each turn.
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("default");
      expect(normalizeIdentityPermissionMode("cto", undefined, "codex")).toBe("default");
    } finally {
      release();
    }
    expect(isIdentityConfirmHeld()).toBe(false);
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("full-auto");
  });

  it("needs every hold released before the CTO can write again", () => {
    const first = beginIdentityConfirmHold();
    const second = beginIdentityConfirmHold();
    first();
    // A second call still running must not be let out by the first hanging up.
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("default");
    // Releasing twice must not credit the counter for a hold nobody took.
    first();
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("default");
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
    const release = beginIdentityConfirmHold();
    try {
      expect(normalizeIdentityPermissionMode(undefined, "full-auto", "claude")).toBe(otherBefore);
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).not.toBe(ctoBefore);
      // Not merely "different" — a mutation answering "edit" would pass that.
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude")).toBe("default");
    } finally {
      release();
    }
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

describe("who owns a session's status line", () => {
  it("says a call is live on the session it is held on, and nowhere else", () => {
    // The chat service asks this before regenerating a session's status line. A
    // live call writes that line itself, deterministically and instantly; the
    // generated one costs a model round trip per settled turn and on a call it
    // always described a question the user had already moved past.
    expect(isIdentityConfirmHeld("session-a")).toBe(false);
    const release = beginIdentityConfirmHold("session-a");
    try {
      expect(isIdentityConfirmHeld("session-a")).toBe(true);
      expect(isIdentityConfirmHeld("session-b")).toBe(false);
    } finally {
      release();
    }
    expect(isIdentityConfirmHeld("session-a")).toBe(false);
  });
});

describe("a confirm hold belongs to one session", () => {
  it("leaves every other CTO session in full-auto", () => {
    // One brain process hosts every open project's scopes and this module is a
    // singleton across all of them, so an unkeyed hold put every project's CTO
    // into confirm-first mode because one of them was on a call.
    const release = beginIdentityConfirmHold("session-a");
    try {
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude", "session-a")).toBe("default");
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude", "session-b")).toBe("full-auto");
      expect(isIdentityConfirmHeld("session-a")).toBe(true);
      expect(isIdentityConfirmHeld("session-b")).toBe(false);
    } finally {
      release();
    }
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude", "session-a")).toBe("full-auto");
  });

  it("counts per session, so overlapping calls cannot release each other early", () => {
    const first = beginIdentityConfirmHold("session-a");
    const second = beginIdentityConfirmHold("session-a");
    first();
    expect(isIdentityConfirmHeld("session-a")).toBe(true);
    second();
    expect(isIdentityConfirmHeld("session-a")).toBe(false);
  });

  it("still answers for everyone when the holder could not name its session", () => {
    // The hold is taken before the lane resolves, so it starts unscoped for a
    // few milliseconds. Losing the gate in that window would be worse than
    // over-applying it.
    const release = beginIdentityConfirmHold();
    try {
      expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude", "session-b")).toBe("default");
    } finally {
      release();
    }
    expect(normalizeIdentityPermissionMode("cto", "full-auto", "claude", "session-b")).toBe("full-auto");
  });
});
