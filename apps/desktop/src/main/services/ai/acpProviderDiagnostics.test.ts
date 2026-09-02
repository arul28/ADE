import { describe, expect, it, vi } from "vitest";
import {
  acpProviderSupportsDoctor,
  collectAcpProviderDiagnostics,
  formatAcpProviderDiagnosticsReport,
} from "./acpProviderDiagnostics";

/** A `spawnAsync` stand-in. Same contract: resolves, never rejects. */
function fakeRun(byArg: Record<string, { status: number | null; stdout?: string; stderr?: string }>) {
  return vi.fn(async (_command: string, args: string[]) => {
    const key = args.join(" ");
    const result = byArg[key] ?? { status: null };
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }) as never;
}

const env = { PATH: "", GROK_EXECUTABLE: "/opt/bin/grok", KIMI_EXECUTABLE: "/opt/bin/kimi", QWEN_EXECUTABLE: "/opt/bin/qwen" };

describe("acpProviderDiagnostics", () => {
  it("declares doctor support rather than guessing it", () => {
    expect(acpProviderSupportsDoctor("grok")).toBe(true);
    expect(acpProviderSupportsDoctor("kimi")).toBe(true);
    // Qwen and Copilot ship no `doctor`; passing the word would be read as a
    // prompt by the agent.
    expect(acpProviderSupportsDoctor("qwen")).toBe(false);
    expect(acpProviderSupportsDoctor("copilot")).toBe(false);
  });

  it("reports version and config home without running doctor by default", async () => {
    const run = fakeRun({ "--version": { status: 0, stdout: "1.0.14\n" } });
    const result = await collectAcpProviderDiagnostics({ provider: "grok", cwd: "/repo", env, run });

    expect(result.version).toBe("1.0.14");
    expect(result.versionError).toBeNull();
    expect(result.binaryPath).toBe("/opt/bin/grok");
    expect(result.binarySource).toBe("env");
    expect(result.configHome).toMatch(/\.grok$/);
    expect(result.doctor).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("folds doctor output in when asked", async () => {
    const run = fakeRun({
      "--version": { status: 0, stdout: "1.0.14" },
      doctor: { status: 1, stdout: "network: ok\n", stderr: "auth: missing\n" },
    });
    const result = await collectAcpProviderDiagnostics({
      provider: "kimi",
      cwd: "/repo",
      env,
      runDoctor: true,
      run,
    });

    expect(result.doctor).toMatchObject({ command: "kimi doctor", exitCode: 1 });
    expect(result.doctor?.output).toContain("auth: missing");
  });

  it("ignores a doctor request for a provider that has no doctor", async () => {
    const run = fakeRun({ "--version": { status: 0, stdout: "0.9.0" } });
    const result = await collectAcpProviderDiagnostics({
      provider: "qwen",
      cwd: "/repo",
      env,
      runDoctor: true,
      run,
    });

    expect(result.doctor).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  // A `--version` that times out resolves with `status: null`. Reporting that
  // as a version would put "null" on the settings page.
  it("names why there is no version instead of inventing one", async () => {
    const run = fakeRun({ "--version": { status: null, stderr: "killed after timeout" } });
    const result = await collectAcpProviderDiagnostics({ provider: "grok", cwd: "/repo", env, run });

    expect(result.version).toBeNull();
    expect(result.versionError).toBe("killed after timeout");
  });

  it("names every absent fact in the copyable report", () => {
    const report = formatAcpProviderDiagnosticsReport({
      provider: "grok",
      binaryPath: null,
      binarySource: "fallback-command",
      configHome: null,
      version: null,
      versionError: "not found",
      lastProbe: null,
      doctor: null,
      checkedAt: "2026-08-31T00:00:00.000Z",
    });

    expect(report).toContain("binary: not found");
    expect(report).toContain("config home: n/a");
    expect(report).toContain("last auth probe: not run");
    expect(report).toContain("status: unknown");
  });
});
