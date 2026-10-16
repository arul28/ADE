import { describe, expect, it } from "vitest";

import {
  PERMISSION_LEVELS,
  permissionLevelForAcp,
  permissionLevelForClaude,
  permissionLevelForCodex,
  permissionLevelForDroid,
  permissionLevelForFamily,
  permissionLevelForOpenCode,
  clampGenericPermissionMode,
  permissionCeilingClamp,
  permissionLevelRank,
  resolvePermissionLevel,
  sessionPermissionLevel,
  type SessionPermissionFields,
  type PermissionLadderControls,
  type PermissionLadderFamily,
  type PermissionLevel,
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

describe("codex axes are independent", () => {
  it("does not treat never-ask plus a sandbox as full autonomy", () => {
    // Both axes are required. Classifying this as full-auto handed Claude
    // bypassPermissions on a family switch — unsandboxed, in a family that has
    // no sandbox axis — which is the rounding up the ladder forbids.
    const level = permissionLevelForCodex("workspace-write", "never");
    expect(level).toBe("auto-edit");
    expect(resolvePermissionLevel(level, "claude").claudePermissionMode).toBe("acceptEdits");
  });

  it("still recognises genuine full autonomy", () => {
    expect(permissionLevelForCodex("danger-full-access", "never")).toBe("full-auto");
  });

  it("treats a read-only sandbox as plan even when approval is lax", () => {
    expect(permissionLevelForCodex("read-only", "never")).toBe("plan");
  });
});

describe("droid agi", () => {
  it("reads as full autonomy so a switch away keeps the top level", () => {
    expect(permissionLevelForDroid("agi")).toBe("full-auto");
  });
});

describe("permissionLevelForFamily reads the level a family's own controls hold", () => {
  // The controls a chat surface carries when every family sits on the ask tier.
  const askControls: PermissionLadderControls = {
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
  };
  const cases: Array<[PermissionLadderFamily, Partial<PermissionLadderControls>, PermissionLevel]> = [
    ["claude", { claudePermissionMode: "bypassPermissions" }, "full-auto"],
    // A Full auto chat carries through to every family the surface can hand off
    // to, which is what `AgentChatPane` resolves when the form opens.
    ["codex", { codexSandbox: "danger-full-access", codexApprovalPolicy: "never" }, "full-auto"],
    // Codex's two axes are independent: never-ask in a sandbox is not full autonomy.
    ["codex", { codexSandbox: "workspace-write", codexApprovalPolicy: "never" }, "auto-edit"],
    ["droid", { droidPermissionMode: "agi" }, "full-auto"],
    ["cursor", { cursorModeId: "ask" }, "plan"],
    ["cursor", { cursorModeId: "full-auto" }, "full-auto"],
    ["opencode", { opencodePermissionMode: "full-auto" }, "full-auto"],
    // ACP has no control of its own; it rides the OpenCode in-process mode.
    ["acp", { opencodePermissionMode: "plan" }, "plan"],
  ];

  it.each(cases)("maps %s from its own controls to %s", (family, overrides, expected) => {
    expect(permissionLevelForFamily(family, { ...askControls, ...overrides })).toBe(expected);
  });
});

describe("permission ceiling", () => {
  // The most open posture each provider can be asked for.
  const fullAuto: Array<[string, SessionPermissionFields]> = [
    ["claude", { provider: "claude", claudePermissionMode: "bypassPermissions", permissionMode: "full-auto" }],
    ["codex", { provider: "codex", codexSandbox: "danger-full-access", codexApprovalPolicy: "never" }],
    ["cursor", { provider: "cursor", cursorModeId: "full-auto" }],
    ["droid", { provider: "droid", droidPermissionMode: "agi" }],
    ["opencode", { provider: "opencode", opencodePermissionMode: "full-auto" }],
    ["qwen", { provider: "qwen", acpPermissionMode: "yolo" }],
    ["pi", { provider: "pi", permissionMode: "full-auto" }],
  ];
  const ceilings: PermissionLevel[] = ["plan", "ask", "auto-edit"];

  it.each(fullAuto.flatMap(([name, fields]) => ceilings.map((ceiling) => [name, ceiling, fields] as const)))(
    "clamps a full-auto %s session to %s and reads back no higher",
    (_name, ceiling, fields) => {
      const clamp = permissionCeilingClamp(fields, ceiling);
      expect(clamp?.requested).toBe("full-auto");
      const clamped = { ...fields, ...clamp!.patch };
      const readBack = sessionPermissionLevel(clamped, "full-auto");
      expect(permissionLevelRank(readBack)).toBeLessThanOrEqual(permissionLevelRank(ceiling));
      // Re-checking the clamped session must not refuse it again.
      expect(permissionCeilingClamp(clamped, ceiling)).toBeNull();
    },
  );

  it.each<[string, SessionPermissionFields, PermissionLevel, PermissionLevel]>([
    // A posture deferred to a config file is unreadable: the side decides.
    ["codex config.toml as a child", { provider: "codex", codexConfigSource: "config-toml" }, "full-auto", "full-auto"],
    ["codex config.toml as a parent", { provider: "codex", codexConfigSource: "config-toml" }, "ask", "ask"],
    // Plan mode over ask-level access is the plan rung; over bypass it is not,
    // because leaving plan mode restores the bypass.
    ["claude plan over default", { provider: "claude", claudePermissionMode: "default", interactionMode: "plan" }, "full-auto", "plan"],
    ["claude plan over bypass", { provider: "claude", claudePermissionMode: "bypassPermissions", interactionMode: "plan" }, "ask", "full-auto"],
    ["unknown provider", { provider: "something-new", permissionMode: "plan" }, "ask", "ask"],
  ])("reads %s", (_label, fields, unknown, expected) => {
    expect(sessionPermissionLevel(fields, unknown)).toBe(expected);
  });

  it.each<[string | null, PermissionLevel, string | null]>([
    ["full-auto", "ask", "default"],
    ["edit", "plan", "plan"],
    ["config-toml", "auto-edit", "edit"],
    [null, "plan", "plan"],
    ["plan", "ask", "plan"],
    ["edit", "full-auto", "edit"],
  ])("caps the generic word %s at %s", (mode, ceiling, expected) => {
    expect(clampGenericPermissionMode(mode, ceiling) ?? null).toBe(expected);
  });
});
