import { describe, expect, it } from "vitest";
import {
  applyClaudePlanModeTransition,
  isSessionInPlanMode,
  resolveClaudeAccessMode,
  type PlanModeSessionFields,
} from "./claudePlanMode";

/**
 * Regression coverage for plan mode being cosmetic in bypass sessions.
 *
 * The reported symptom was a plan that "auto-accepted" with no approval card
 * and a composer chip that never left Bypass. Both came from the same cause:
 * entering plan mode moved `permissionMode` and `interactionMode` but left
 * `claudePermissionMode` alone — and that is the field the composer renders
 * and the `ExitPlanMode` gate reads.
 */

function session(overrides: Partial<PlanModeSessionFields> = {}): PlanModeSessionFields {
  return {
    permissionMode: "default",
    interactionMode: "default",
    claudePermissionMode: "default",
    claudePrePlanAccessMode: null,
    ...overrides,
  };
}

describe("applyClaudePlanModeTransition", () => {
  it("moves the access mode into plan, not just the interaction mode", () => {
    const s = session({ permissionMode: "full-auto", claudePermissionMode: "bypassPermissions" });

    applyClaudePlanModeTransition(s, "plan");

    // All three must agree, or some surface still believes it's in bypass.
    expect(s.interactionMode).toBe("plan");
    expect(s.permissionMode).toBe("plan");
    expect(s.claudePermissionMode).toBe("plan");
  });

  it("makes a bypass session read as genuinely in plan mode", () => {
    const s = session({ permissionMode: "full-auto", claudePermissionMode: "bypassPermissions" });
    applyClaudePlanModeTransition(s, "plan");

    // The ExitPlanMode gate reads `claudePermissionMode ?? permissionMode`.
    // Neither may say bypass, or the plan is auto-approved with no card.
    const effectiveAccess = s.claudePermissionMode ?? s.permissionMode;
    expect(effectiveAccess).not.toBe("bypassPermissions");
    expect(s.permissionMode).not.toBe("full-auto");
    expect(isSessionInPlanMode(s)).toBe(true);
  });

  it("restores the suspended access mode on exit", () => {
    const s = session({ permissionMode: "full-auto", claudePermissionMode: "bypassPermissions" });

    applyClaudePlanModeTransition(s, "plan");
    applyClaudePlanModeTransition(s, "default");

    expect(s.claudePermissionMode).toBe("bypassPermissions");
    expect(s.permissionMode).toBe("full-auto");
    expect(s.interactionMode).toBe("default");
    expect(s.claudePrePlanAccessMode).toBeNull();
    expect(isSessionInPlanMode(s)).toBe(false);
  });

  it.each([
    ["bypassPermissions", "full-auto"],
    ["acceptEdits", "edit"],
    ["auto", "auto"],
    ["default", "default"],
  ] as const)("round-trips %s without demoting the session", (access, legacy) => {
    const s = session({ permissionMode: legacy, claudePermissionMode: access });

    applyClaudePlanModeTransition(s, "plan");
    applyClaudePlanModeTransition(s, "default");

    expect(s.claudePermissionMode).toBe(access);
    expect(s.permissionMode).toBe(legacy);
  });

  it("does not stash the plan sentinel when plan mode is entered twice", () => {
    const s = session({ permissionMode: "full-auto", claudePermissionMode: "bypassPermissions" });

    applyClaudePlanModeTransition(s, "plan");
    applyClaudePlanModeTransition(s, "plan");
    applyClaudePlanModeTransition(s, "default");

    // A second entry must not overwrite the stash with "plan" itself.
    expect(s.claudePermissionMode).toBe("bypassPermissions");
  });

  it("falls back to the legacy permission mode when no access mode is set", () => {
    const s = session({ permissionMode: "edit", claudePermissionMode: undefined });

    applyClaudePlanModeTransition(s, "plan");
    applyClaudePlanModeTransition(s, "default");

    expect(s.claudePermissionMode).toBe("acceptEdits");
    expect(s.permissionMode).toBe("edit");
  });

  it("exits cleanly from a stale session that never stashed a mode", () => {
    // A session persisted before the stash existed: in plan mode with no
    // record of what it was doing beforehand.
    const s = session({
      permissionMode: "plan",
      interactionMode: "plan",
      claudePermissionMode: "plan",
      claudePrePlanAccessMode: null,
    });

    applyClaudePlanModeTransition(s, "default");

    expect(s.claudePermissionMode).toBe("default");
    expect(s.permissionMode).toBe("default");
    expect(isSessionInPlanMode(s)).toBe(false);
  });
});

describe("resolveClaudeAccessMode", () => {
  it("ignores the plan sentinel when resolving an access mode", () => {
    expect(resolveClaudeAccessMode({ claudePermissionMode: "plan", permissionMode: "full-auto" }))
      .toBe("bypassPermissions");
  });

  it("prefers the explicit access mode over the legacy field", () => {
    expect(resolveClaudeAccessMode({ claudePermissionMode: "acceptEdits", permissionMode: "full-auto" }))
      .toBe("acceptEdits");
  });
});

describe("isSessionInPlanMode", () => {
  it("detects plan mode from any of the three fields", () => {
    expect(isSessionInPlanMode(session({ permissionMode: "plan" }))).toBe(true);
    expect(isSessionInPlanMode(session({ interactionMode: "plan" }))).toBe(true);
    expect(isSessionInPlanMode(session({ claudePermissionMode: "plan" }))).toBe(true);
  });

  it("is false for a bypass session that never entered plan mode", () => {
    expect(isSessionInPlanMode(session({
      permissionMode: "full-auto",
      claudePermissionMode: "bypassPermissions",
    }))).toBe(false);
  });
});
describe("persistence round-trip", () => {
  it("restores the pre-plan mode after the session is rehydrated mid-plan", () => {
    // `claudePrePlanAccessMode` is persisted and rehydrated by
    // `agentChatService`'s explicit session field whitelist. If it were ever
    // dropped from that list, a restart while in plan mode would lose the
    // suspended mode and exiting would silently demote the session — the same
    // class of bug this whole change fixes.
    const live = session({ permissionMode: "full-auto", claudePermissionMode: "bypassPermissions" });
    applyClaudePlanModeTransition(live, "plan");

    // Simulate persist → restart → rehydrate.
    const rehydrated: PlanModeSessionFields = {
      permissionMode: live.permissionMode,
      interactionMode: live.interactionMode,
      claudePermissionMode: live.claudePermissionMode,
      claudePrePlanAccessMode: live.claudePrePlanAccessMode,
    };

    applyClaudePlanModeTransition(rehydrated, "default");

    expect(rehydrated.claudePermissionMode).toBe("bypassPermissions");
    expect(rehydrated.permissionMode).toBe("full-auto");
  });

  it("demotes to default when the stash was dropped, proving the field matters", () => {
    // Same flow with the stash stripped — this is what the bug looked like.
    const live = session({ permissionMode: "full-auto", claudePermissionMode: "bypassPermissions" });
    applyClaudePlanModeTransition(live, "plan");

    const withoutStash: PlanModeSessionFields = {
      permissionMode: live.permissionMode,
      interactionMode: live.interactionMode,
      claudePermissionMode: live.claudePermissionMode,
      claudePrePlanAccessMode: null,
    };

    applyClaudePlanModeTransition(withoutStash, "default");

    expect(withoutStash.claudePermissionMode).toBe("default");
  });
});
