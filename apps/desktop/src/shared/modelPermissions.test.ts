import { describe, expect, it } from "vitest";

import {
  defaultModelPermission,
  isModelPermissionValue,
  modelPermissionLabel,
  modelPermissionOptions,
  nativePermissionToCliMode,
  resolveModelPermissionValue,
} from "./modelPermissions";

describe("model permission vocabulary", () => {
  it("uses each provider's own modes and default", () => {
    expect(modelPermissionOptions("claude").map((option) => option.value)).toEqual([
      "default",
      "auto",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(isModelPermissionValue("claude", "bypassPermissions")).toBe(true);
    expect(isModelPermissionValue("opencode", "bypassPermissions")).toBe(false);
    expect(modelPermissionOptions("opencode").map((option) => option.value)).toEqual([
      "plan",
      "edit",
      "full-auto",
      "config-toml",
    ]);
    expect(defaultModelPermission("claude")).toBe("default");
    expect(defaultModelPermission("opencode")).toBe("edit");
    expect(defaultModelPermission("cursor")).toBe("agent");
    expect(defaultModelPermission("droid")).toBe("auto-low");
  });

  it("resolves a legacy mode onto the provider's own mode, and rejects a foreign native one", () => {
    // A chip written before this module (`perm=full-auto`) still renders Bypass.
    expect(resolveModelPermissionValue("claude", "full-auto")).toBe("bypassPermissions");
    expect(modelPermissionLabel("claude", "full-auto")).toBe("Bypass");
    // A native value copied from another provider's chip means nothing here.
    expect(resolveModelPermissionValue("opencode", "bypassPermissions")).toBeNull();
    expect(nativePermissionToCliMode("opencode", "bypassPermissions")).toBeNull();
  });

  it("maps each provider's native mode back to the generic CLI word", () => {
    expect(nativePermissionToCliMode("claude", "bypassPermissions")).toBe("full-auto");
    expect(nativePermissionToCliMode("claude", "acceptEdits")).toBe("edit");
    expect(nativePermissionToCliMode("codex", "config-toml")).toBe("config-toml");
    expect(nativePermissionToCliMode("opencode", "full-auto")).toBe("full-auto");
    expect(nativePermissionToCliMode("cursor", "agent")).toBe("default");
    expect(nativePermissionToCliMode("droid", "auto-high")).toBe("full-auto");
    expect(nativePermissionToCliMode("droid", "agi")).toBe("full-auto");
  });
});
