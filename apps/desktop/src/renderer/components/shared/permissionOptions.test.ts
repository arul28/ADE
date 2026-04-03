import { describe, expect, it } from "vitest";
import {
  getPermissionOptions,
  normalizePermissionModeForProfile,
  resolvePersistentIdentityGuardedPermissionMode,
  safetyBadgeLabel,
  safetyColorHex,
  safetyColors,
  familyToPermissionKey,
  permissionFamilyLabel,
  type SafetyLevel,
} from "./permissionOptions";

describe("resolvePersistentIdentityGuardedPermissionMode", () => {
  it("returns 'default' for CLI-wrapped anthropic", () => {
    expect(resolvePersistentIdentityGuardedPermissionMode({ family: "anthropic", isCliWrapped: true })).toBe("default");
    // 'claude' normalizes to 'anthropic'
    expect(resolvePersistentIdentityGuardedPermissionMode({ family: "claude", isCliWrapped: true })).toBe("default");
  });

  it("returns 'edit' for non-CLI-wrapped or non-anthropic families", () => {
    expect(resolvePersistentIdentityGuardedPermissionMode({ family: "anthropic", isCliWrapped: false })).toBe("edit");
    expect(resolvePersistentIdentityGuardedPermissionMode({ family: "openai", isCliWrapped: true })).toBe("edit");
    expect(resolvePersistentIdentityGuardedPermissionMode({ family: "local", isCliWrapped: false })).toBe("edit");
  });
});

describe("normalizePermissionModeForProfile", () => {
  it("returns provided mode for non-persistent_identity profiles", () => {
    expect(normalizePermissionModeForProfile({ family: "anthropic", isCliWrapped: true, mode: "full-auto" })).toBe("full-auto");
    expect(normalizePermissionModeForProfile({ family: "anthropic", isCliWrapped: true, mode: "edit" })).toBe("edit");
  });

  it("defaults to 'plan' for non-persistent_identity without mode", () => {
    expect(normalizePermissionModeForProfile({ family: "anthropic", isCliWrapped: true })).toBe("plan");
  });

  it("returns 'full-auto' for persistent_identity when mode is full-auto", () => {
    expect(
      normalizePermissionModeForProfile({
        profile: "persistent_identity",
        family: "anthropic",
        isCliWrapped: true,
        mode: "full-auto",
      }),
    ).toBe("full-auto");
  });

  it("returns guarded mode for persistent_identity with non-full-auto mode", () => {
    expect(
      normalizePermissionModeForProfile({
        profile: "persistent_identity",
        family: "anthropic",
        isCliWrapped: true,
        mode: "plan",
      }),
    ).toBe("default"); // CLI-wrapped anthropic -> "default"
  });
});

describe("getPermissionOptions", () => {
  it("returns persistent_identity options for that profile", () => {
    const options = getPermissionOptions({ family: "anthropic", isCliWrapped: true, profile: "persistent_identity" });
    expect(options).toHaveLength(2);
    expect(options[0]!.label).toBe("Default");
    expect(options[1]!.label).toBe("Full Access");
    expect(options[1]!.safety).toBe("danger");
  });

  it("returns anthropic CLI options for CLI-wrapped anthropic", () => {
    const options = getPermissionOptions({ family: "anthropic", isCliWrapped: true });
    expect(options).toHaveLength(4);
    expect(options.map((o) => o.value)).toEqual(["default", "edit", "plan", "full-auto"]);
  });

  it("returns openai CLI options for CLI-wrapped openai", () => {
    const options = getPermissionOptions({ family: "openai", isCliWrapped: true });
    expect(options).toHaveLength(4);
    expect(options.map((o) => o.value)).toEqual(["plan", "edit", "full-auto", "config-toml"]);
  });

  it("returns API/local options for CLI-wrapped codex family (family normalization only applies to guarded mode)", () => {
    // 'codex' as a family string does not match the openai CLI branch (which checks opts.family === "openai")
    const options = getPermissionOptions({ family: "codex", isCliWrapped: true });
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.value)).toEqual(["plan", "edit", "full-auto"]);
  });

  it("returns API/local model options for non-CLI-wrapped families", () => {
    const options = getPermissionOptions({ family: "anthropic", isCliWrapped: false });
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.value)).toEqual(["plan", "edit", "full-auto"]);
  });

  it("returns API/local model options for unknown families", () => {
    const options = getPermissionOptions({ family: "local-model", isCliWrapped: false });
    expect(options).toHaveLength(3);
  });

  it("every option has required fields populated", () => {
    const allOptions = [
      ...getPermissionOptions({ family: "anthropic", isCliWrapped: true }),
      ...getPermissionOptions({ family: "openai", isCliWrapped: true }),
      ...getPermissionOptions({ family: "local", isCliWrapped: false }),
    ];
    for (const option of allOptions) {
      expect(option.value, `option ${option.label} should have a value`).toBeTruthy();
      expect(option.label, `option with value ${option.value} should have a label`).toBeTruthy();
      expect(option.shortDesc, `option ${option.label} should have a shortDesc`).toBeTruthy();
      expect(option.detail, `option ${option.label} should have a detail`).toBeTruthy();
      expect(option.allows.length, `option ${option.label} should have allows`).toBeGreaterThan(0);
      expect(option.safety, `option ${option.label} should have a safety level`).toBeTruthy();
    }
  });
});

describe("safetyBadgeLabel", () => {
  it("maps all safety levels to labels", () => {
    expect(safetyBadgeLabel("safe")).toBe("SAFE");
    expect(safetyBadgeLabel("semi-auto")).toBe("SEMI-AUTO");
    expect(safetyBadgeLabel("full-auto")).toBe("FULL-AUTO");
    expect(safetyBadgeLabel("danger")).toBe("DANGER");
    expect(safetyBadgeLabel("custom")).toBe("CUSTOM");
  });
});

describe("safetyColorHex", () => {
  it("returns hex colors for all safety levels", () => {
    const levels: SafetyLevel[] = ["safe", "semi-auto", "full-auto", "danger", "custom"];
    for (const level of levels) {
      const hex = safetyColorHex(level);
      expect(hex, `${level} should return a hex color`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("safetyColors", () => {
  it("returns tailwind class objects for all safety levels", () => {
    const levels: SafetyLevel[] = ["safe", "semi-auto", "full-auto", "danger", "custom"];
    for (const level of levels) {
      const colors = safetyColors(level);
      expect(colors.border, `${level} should have border class`).toBeTruthy();
      expect(colors.badge, `${level} should have badge class`).toBeTruthy();
      expect(colors.activeBg, `${level} should have activeBg class`).toBeTruthy();
    }
  });
});

describe("familyToPermissionKey", () => {
  it("maps CLI-wrapped anthropic to 'claude'", () => {
    expect(familyToPermissionKey("anthropic", true)).toBe("claude");
  });

  it("maps CLI-wrapped openai to 'codex'", () => {
    expect(familyToPermissionKey("openai", true)).toBe("codex");
  });

  it("maps CLI-wrapped factory models to 'droid'", () => {
    expect(familyToPermissionKey("factory", true)).toBe("droid");
  });

  it("maps everything else to 'opencode'", () => {
    expect(familyToPermissionKey("anthropic", false)).toBe("opencode");
    expect(familyToPermissionKey("openai", false)).toBe("opencode");
    expect(familyToPermissionKey("local", true)).toBe("opencode");
    expect(familyToPermissionKey("unknown", false)).toBe("opencode");
  });
});

describe("permissionFamilyLabel", () => {
  it("returns human-readable labels for all keys", () => {
    expect(permissionFamilyLabel("claude")).toBe("Claude Code workers");
    expect(permissionFamilyLabel("codex")).toBe("Codex workers");
    expect(permissionFamilyLabel("droid")).toBe("Droid workers");
    expect(permissionFamilyLabel("opencode")).toBe("OpenCode workers");
  });
});
