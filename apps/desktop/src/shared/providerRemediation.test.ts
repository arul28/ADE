import { describe, expect, it } from "vitest";

import {
  PROVIDER_REMEDIATION,
  REMEDIATION_PROVIDERS,
  pickPlatformCommand,
  resolveProviderRemediation,
  type ProviderRemediation,
} from "./providerRemediation";

describe("resolveProviderRemediation — Windows parity", () => {
  it("never offers a vendor install command because ADE manages the pinned copy", () => {
    for (const provider of REMEDIATION_PROVIDERS) {
      const resolved = resolveProviderRemediation(provider, "win32");
      expect(resolved.installCommand).toBeNull();
    }
  });

  it("uses a Windows-specific sign-in command only when the provider defines one", () => {
    const cursorLogin = PROVIDER_REMEDIATION.cursor.loginCommand;
    expect(resolveProviderRemediation("cursor", "win32").loginCommand).toBe(cursorLogin);
    expect(resolveProviderRemediation("cursor", "darwin").loginCommand).toBe(cursorLogin);
  });

  it("keeps provider sign-in commands available on both platforms", () => {
    for (const provider of ["codex", "opencode", "pi"] as const) {
      const base = PROVIDER_REMEDIATION[provider].loginCommand;
      expect(resolveProviderRemediation(provider, "win32").loginCommand).toBe(base);
    }
  });
});

describe("pickPlatformCommand", () => {
  const base: ProviderRemediation = {
    displayName: "Test",
    loginCommand: "test login",
    docsUrl: "https://example.test/docs",
  };

  it("keeps the base command off win32", () => {
    const entry = { ...base, windowsLoginCommand: "irm x | iex" };
    expect(pickPlatformCommand(entry, "windowsLoginCommand", entry.loginCommand, "darwin"))
      .toBe(base.loginCommand);
  });

  it("keeps the base command on win32 when the row names no override", () => {
    expect(pickPlatformCommand(base, "windowsLoginCommand", base.loginCommand, "win32"))
      .toBe(base.loginCommand);
  });

  it("uses the override on win32", () => {
    const entry = { ...base, windowsLoginCommand: "irm x | iex" };
    expect(pickPlatformCommand(entry, "windowsLoginCommand", entry.loginCommand, "win32"))
      .toBe("irm x | iex");
  });

  it("treats an empty-string override as an override, not as absent", () => {
    const entry = { ...base, windowsLoginCommand: "" };
    expect(pickPlatformCommand(entry, "windowsLoginCommand", entry.loginCommand, "win32"))
      .toBe("");
  });
});
