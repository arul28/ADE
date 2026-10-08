import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acpProviderOutdatedNotice,
  acpProviderSupportsDoctor,
  collectAcpProviderDiagnostics,
  formatAcpProviderDiagnosticsReport,
  readAcpProviderLaunchStanding,
  runAcpProviderUpdate,
} from "./acpProviderDiagnostics";
import { ACP_PROVIDER_VERSION_POLICY, type AcpInstallerIo, type AcpSpawn } from "./acpProviderUpdate";

/** A `spawnAsync` stand-in. Same contract: resolves, never rejects. */
function fakeRun(byArg: Record<string, { status: number | null; stdout?: string; stderr?: string }>) {
  return vi.fn(async (_command: string, args: string[]) => {
    const key = args.join(" ");
    const result = byArg[key] ?? { status: null };
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }) as never;
}

/** Force every installer to look unresolved, whatever exists on the test machine. */
const noInstaller: AcpInstallerIo = { exists: () => false, realpath: (path) => path, readFirstLine: () => null };
/** A real file at `binary` that is not a Node script: a vendor-native binary. */
const nativeAt = (binary: string): AcpInstallerIo => ({
  exists: (path) => path === binary,
  realpath: (path) => path,
  readFirstLine: () => null,
});

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
    const result = await collectAcpProviderDiagnostics({ provider: "grok", cwd: "/repo", env, run, installerIo: noInstaller });

    expect(result.version).toBe("1.0.14");
    expect(result.versionError).toBeNull();
    expect(result.binaryPath).toBe("/opt/bin/grok");
    expect(result.binarySource).toBe("env");
    expect(result.configHome).toMatch(/\.grok$/);
    expect(result.doctor).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a custom GROK_HOME instead of the default path", async () => {
    const run = fakeRun({ "--version": { status: 0, stdout: "1.0.34\n" } });
    const result = await collectAcpProviderDiagnostics({
      provider: "grok",
      cwd: "/repo",
      env: { ...env, GROK_HOME: "/tmp/grok-custom" },
      run,
      installerIo: noInstaller,
    });

    expect(result.configHome).toBe("/tmp/grok-custom");
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
    const result = await collectAcpProviderDiagnostics({ provider: "grok", cwd: "/repo", env, run, installerIo: noInstaller });

    expect(result.version).toBeNull();
    expect(result.versionError).toBe("killed after timeout");
  });

  it.each([
    ["grok", "/opt/bin/grok", "1.0.13\n", "below", true],
    ["qwen", "/opt/bin/qwen", `${ACP_PROVIDER_VERSION_POLICY.qwen.tested.max}\n`, "tested", false],
  ] as const)("attaches %s's standing against its tested range", async (provider, binary, stdout, standing, canUpdate) => {
    const run = fakeRun({ "--version": { status: 0, stdout } });
    const result = await collectAcpProviderDiagnostics({ provider, cwd: "/repo", env, run, installerIo: nativeAt(binary) });

    expect(result.version).toBe(stdout.trim());
    expect(result.update?.standing).toBe(standing);
    expect(result.update?.canUpdate).toBe(canUpdate);
    expect(result.update?.targetVersion).toBe(ACP_PROVIDER_VERSION_POLICY[provider].tested.max);
  });

  it("updates Grok in its own config home, to the newest tested version", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: AcpSpawn = async (_command, args, opts) => {
      calls.push({ args, env: opts.env });
      return { status: 0, stdout: `${ACP_PROVIDER_VERSION_POLICY.grok.tested.max}\n`, stderr: "" };
    };
    const result = await runAcpProviderUpdate({
      provider: "grok",
      cwd: "/repo",
      // A relative home: the update must use the same resolved home that
      // diagnostics report, not whatever the updater's working folder implies.
      env: { ...env, GROK_HOME: "relative/grok-home" },
      run,
      installerIo: nativeAt("/opt/bin/grok"),
    });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([
      ["update", "--version", ACP_PROVIDER_VERSION_POLICY.grok.tested.max],
      ["--version"],
    ]);
    expect(calls.every((call) => call.env.GROK_HOME === path.resolve("relative/grok-home"))).toBe(true);
  });

  it("joins a second update of the same CLI to the one already running", async () => {
    let finish: (value: { status: number; stdout: string; stderr: string }) => void = () => {};
    const installs: string[][] = [];
    const run: AcpSpawn = (_command, args) => {
      if (args[0] === "--version") {
        return Promise.resolve({ status: 0, stdout: `${ACP_PROVIDER_VERSION_POLICY.grok.tested.max}\n`, stderr: "" });
      }
      installs.push(args);
      return new Promise((resolve) => { finish = resolve; });
    };
    const update = () => runAcpProviderUpdate({ provider: "grok", cwd: "/repo", env: { ...env, GROK_EXECUTABLE: "/opt/single-flight/grok" }, run, installerIo: nativeAt("/opt/single-flight/grok") });

    const first = update();
    const second = update();
    await vi.waitFor(() => expect(installs).toHaveLength(1));
    finish({ status: 0, stdout: "", stderr: "" });
    const [a, b] = await Promise.all([first, second]);

    expect(installs).toHaveLength(1);
    expect(a.ok).toBe(true);
    expect(b).toBe(a);
    // Once it settles, a later request runs a new install.
    const third = update();
    await vi.waitFor(() => expect(installs).toHaveLength(2));
    finish({ status: 0, stdout: "", stderr: "" });
    expect((await third).ok).toBe(true);
  });

  it("refuses an update ADE cannot place instead of running a guess", async () => {
    const run = vi.fn() as unknown as AcpSpawn;
    const result = await runAcpProviderUpdate({ provider: "kimi", cwd: "/repo", env, run, installerIo: noInstaller });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not tell how this Kimi was installed/);
    expect(run).not.toHaveBeenCalled();
  });

  it("warns a chat only when its CLI is below the tested range, reading the version once", async () => {
    const below = fakeRun({ "--version": { status: 0, stdout: "0.10.0\n" } });
    const launchEnv = { PATH: "", QWEN_EXECUTABLE: "/opt/launch-test/qwen" };
    const first = await readAcpProviderLaunchStanding({ provider: "qwen", cwd: "/repo", env: launchEnv, run: below });
    const second = await readAcpProviderLaunchStanding({ provider: "qwen", cwd: "/repo", env: launchEnv, run: below });

    expect(second).toBe(first);
    expect(below).toHaveBeenCalledTimes(1);
    // The check runs with the chat's environment (its PATH finds the CLI's Node).
    expect(below).toHaveBeenCalledWith("/opt/launch-test/qwen", ["--version"], expect.objectContaining({ env: launchEnv }));
    const notice = acpProviderOutdatedNotice("qwen", first);
    expect(notice).toMatchObject({ type: "system_notice", status: "acp_provider_outdated", severity: "warning" });
    expect(notice && notice.type === "system_notice" && typeof notice.detail === "object" ? notice.detail.providerUpdate : null)
      .toMatchObject({ provider: "qwen", installedVersion: "0.10.0", targetVersion: ACP_PROVIDER_VERSION_POLICY.qwen.tested.max });

    // Inside the range, above it, or unreadable: no warning.
    for (const stdout of [`${ACP_PROVIDER_VERSION_POLICY.grok.tested.min}\n`, "99.0.0\n", "dev build\n"]) {
      const info = await readAcpProviderLaunchStanding({
        provider: "grok",
        cwd: "/repo",
        env: { PATH: "", GROK_EXECUTABLE: `/opt/launch-test/grok-${stdout.trim()}` },
        run: fakeRun({ "--version": { status: 0, stdout } }),
      });
      expect(acpProviderOutdatedNotice("grok", info)).toBeNull();
    }
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
