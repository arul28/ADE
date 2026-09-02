import { describe, expect, it } from "vitest";

import {
  PROVIDER_REMEDIATION,
  REMEDIATION_PROVIDERS,
  pickPlatformCommand,
  resolveProviderRemediation,
  type ProviderRemediation,
} from "./providerRemediation";

/** A `curl … | sh` line handed to a Windows user is a dead end, not a fix. */
const POSIX_PIPE = /^(curl|wget)\b[\s\S]*\|\s*(ba)?sh\b/;

describe("resolveProviderRemediation — Windows parity", () => {
  it("never hands a Windows user a POSIX shell pipe", () => {
    for (const provider of REMEDIATION_PROVIDERS) {
      const resolved = resolveProviderRemediation(provider, "win32");
      expect(resolved.installCommand ?? "").not.toMatch(POSIX_PIPE);
      expect(resolved.loginCommand ?? "").not.toMatch(POSIX_PIPE);
    }
  });

  it("uses Cursor's own Windows installer, not its bash pipe", () => {
    // Cursor runs natively on Windows x64, so the row is live there. It is the
    // one row whose POSIX command is a pipe and whose vendor ships a separate
    // Windows installer.
    expect(resolveProviderRemediation("cursor", "win32").installCommand).toBe(
      "irm 'https://cursor.com/install?win32=true' | iex",
    );
    expect(resolveProviderRemediation("cursor", "darwin").installCommand).toBe(
      PROVIDER_REMEDIATION.cursor.installCommand,
    );
  });

  it("keeps the platform-neutral npm commands on both platforms", () => {
    for (const provider of ["codex", "opencode", "pi"] as const) {
      const base = PROVIDER_REMEDIATION[provider].installCommand;
      expect(base.startsWith("npm install -g")).toBe(true);
      expect(resolveProviderRemediation(provider, "win32").installCommand).toBe(base);
    }
  });
});

describe("pickPlatformCommand", () => {
  const base: ProviderRemediation = {
    displayName: "Test",
    installCommand: "curl https://example.test/install -fsS | bash",
    loginCommand: "test login",
    docsUrl: "https://example.test/docs",
  };

  it("keeps the base command off win32", () => {
    const entry = { ...base, windowsInstallCommand: "irm x | iex" };
    expect(pickPlatformCommand(entry, "windowsInstallCommand", entry.installCommand, "darwin"))
      .toBe(base.installCommand);
  });

  it("keeps the base command on win32 when the row names no override", () => {
    expect(pickPlatformCommand(base, "windowsInstallCommand", base.installCommand, "win32"))
      .toBe(base.installCommand);
  });

  it("uses the override on win32", () => {
    const entry = { ...base, windowsInstallCommand: "irm x | iex" };
    expect(pickPlatformCommand(entry, "windowsInstallCommand", entry.installCommand, "win32"))
      .toBe("irm x | iex");
  });

  it("reports no command on win32 for an explicit null override", () => {
    // "This vendor has no Windows installer" must beat the POSIX pipe, so the
    // host falls back to `docsUrl` rather than printing an unrunnable line.
    const entry = { ...base, windowsInstallCommand: null };
    expect(pickPlatformCommand(entry, "windowsInstallCommand", entry.installCommand, "win32"))
      .toBeNull();
  });

  it("treats an empty-string override as an override, not as absent", () => {
    const entry = { ...base, windowsInstallCommand: "" };
    expect(pickPlatformCommand(entry, "windowsInstallCommand", entry.installCommand, "win32"))
      .toBe("");
  });
});
