import { describe, expect, it } from "vitest";

import {
  PERMISSION_LEVELS,
  permissionLevelForAcp,
  permissionLevelForClaude,
  permissionLevelForCodex,
  permissionLevelForDroid,
  permissionLevelForOpenCode,
  permissionLevelRank,
  resolvePermissionLevel,
} from "./permissionLadder";

describe("round trip", () => {
  it("maps every level onto Claude and back", () => {
    for (const level of PERMISSION_LEVELS) {
      const resolved = resolvePermissionLevel(level, "claude");
      expect(permissionLevelForClaude(resolved.claudePermissionMode)).toBe(level);
    }
  });

  it("maps every level onto Codex and back", () => {
    for (const level of PERMISSION_LEVELS) {
      const resolved = resolvePermissionLevel(level, "codex");
      expect(permissionLevelForCodex(resolved.codexSandbox, resolved.codexApprovalPolicy)).toBe(level);
    }
  });

  it("maps every level onto Droid and back", () => {
    for (const level of PERMISSION_LEVELS) {
      const resolved = resolvePermissionLevel(level, "droid");
      expect(permissionLevelForDroid(resolved.droidPermissionMode)).toBe(level);
    }
  });

  it("maps every level onto ACP and back", () => {
    for (const level of PERMISSION_LEVELS) {
      const resolved = resolvePermissionLevel(level, "acp");
      expect(permissionLevelForAcp(resolved.acpPermissionMode)).toBe(level);
    }
  });
});

describe("the highest level transfers across families", () => {
  it("keeps full autonomy when switching Claude to Droid", () => {
    const fromClaude = permissionLevelForClaude("bypassPermissions");
    expect(resolvePermissionLevel(fromClaude, "droid").droidPermissionMode).toBe("auto-high");
  });

  it("keeps plan when switching Droid to Codex", () => {
    const fromDroid = permissionLevelForDroid("read-only");
    const codex = resolvePermissionLevel(fromDroid, "codex");
    expect(codex.codexSandbox).toBe("read-only");
    expect(codex.codexApprovalPolicy).toBe("untrusted");
  });
});

describe("nearest lower rule", () => {
  it("never rounds a level UP into more freedom than the user chose", () => {
    const resolved = resolvePermissionLevel("auto-edit", "opencode");
    expect(resolved.opencodePermissionMode).toBe("edit");
    expect(resolved.level).toBe("ask");
    expect(permissionLevelRank(resolved.level)).toBeLessThan(permissionLevelRank("auto-edit"));
    expect(resolved.downgraded).toBe(true);
  });

  it("reports no downgrade when the family expresses the level exactly", () => {
    expect(resolvePermissionLevel("full-auto", "opencode").downgraded).toBe(false);
    expect(resolvePermissionLevel("auto-edit", "claude").downgraded).toBe(false);
  });

  it("only reports a downgrade for the family being switched to", () => {
    // Claude expresses auto-edit exactly, even though OpenCode cannot.
    const claude = resolvePermissionLevel("auto-edit", "claude");
    expect(claude.downgraded).toBe(false);
    expect(claude.level).toBe("auto-edit");
  });
});

describe("droid agi", () => {
  it("reads as full autonomy so a switch away keeps the top level", () => {
    expect(permissionLevelForDroid("agi")).toBe("full-auto");
  });
});
