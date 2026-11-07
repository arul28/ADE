import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPendingAutoDiagnosticsNotices,
  resolveAutoDiagnosticsStateFile,
  setAutoDiagnosticsEnabled,
} from "../../../../desktop/src/main/services/diagnostics/autoDiagnosticsStore";
import { resolveReleaseChannel } from "../../../../desktop/src/shared/packageChannel";
import { brainReportsAsRelease } from "../../sentry/brainBuild";
import {
  createBrainAutoDiagnostics,
  type BrainDiagnosticsBuild,
  type BrainDiagnosticsSend,
} from "./autoDiagnosticsSender";

const dirs: string[] = [];
const T0 = Date.parse("2026-08-19T10:00:00.000Z");

function adeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-auto-diagnostics-"));
  dirs.push(dir);
  return dir;
}

type SendResult = { ok: true; reference: string } | { ok: false; reason: string };

function harness(options: { home?: string; sendResult?: SendResult; devBuild?: boolean } = {}) {
  const home = options.home ?? adeHome();
  const env = { ADE_HOME: home } as NodeJS.ProcessEnv;
  const stateFilePath = resolveAutoDiagnosticsStateFile(home, env);
  // No casts: the seams are structural, so these stubs are checked against the
  // shape the sender actually calls them with.
  const send = vi.fn<Parameters<BrainDiagnosticsSend>, ReturnType<BrainDiagnosticsSend>>(
    async () => options.sendResult ?? { ok: true as const, reference: "abcd1234" },
  );
  const build = vi.fn<Parameters<BrainDiagnosticsBuild>, ReturnType<BrainDiagnosticsBuild>>(() => ({
    report: "# brain report",
    installId: "install-1",
    appVersion: "1.2.3",
    secretsDir: path.join(home, "secrets"),
  }));
  const writeReportFile = vi.fn((_filePath: string, _report: string) => true);
  const sender = createBrainAutoDiagnostics({
    env,
    cliVersion: "1.2.3",
    now: () => T0,
    build,
    send,
    writeReportFile,
    devBuild: options.devBuild,
  });
  return { sender, stateFilePath, send, build, writeReportFile, home };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createBrainAutoDiagnostics", () => {
  it("a development brain reports as development and never sends a report on its own", async () => {
    const installed = "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs";
    const channelOf = (env: NodeJS.ProcessEnv, modulePath: string) =>
      resolveReleaseChannel({ env, packaged: brainReportsAsRelease(env, modulePath), version: "1.2.130" });
    // A source checkout's bundle, wherever it was started from, and a brain the
    // dev launcher started (even one running an installed bundle) are
    // development; only an installed bundle on its own is the release.
    expect(channelOf({ ADE_RUNTIME_PACKAGED: "1" }, "/Users/ada/ADE/apps/ade-cli/dist/cli.cjs")).toBe("development");
    expect(channelOf({ ADE_DEV_BRAIN: "1" }, installed)).toBe("development");
    expect(channelOf({}, installed)).toBe("stable");

    const home = adeHome();
    const dev = harness({ home, devBuild: !brainReportsAsRelease({ ADE_DEV_BRAIN: "1" }, installed) });
    await expect(dev.sender.report({ failureCode: "machine_revoked", surface: "machine_pairing_recovery" }))
      .resolves.toBe("skipped_ineligible");
    expect(dev.build).not.toHaveBeenCalled();
    expect(dev.send).not.toHaveBeenCalled();
    // Nothing was spent: the release brain on the same machine still sends.
    const release = harness({ home, devBuild: !brainReportsAsRelease({}, installed) });
    await expect(release.sender.report({ failureCode: "machine_revoked", surface: "machine_pairing_recovery" }))
      .resolves.toBe("completed");
  });

  it("sends with the failure code and leaves the toast for the desktop to show", async () => {
    const { sender, send, build, writeReportFile, stateFilePath, home } = harness();

    await expect(
      sender.report({ failureCode: "machine_revoked", surface: "machine_pairing_recovery" }),
    ).resolves.toBe("completed");

    expect(build.mock.calls[0]?.[0]).toMatchObject({
      surface: "machine_pairing_recovery",
      code: "machine_revoked",
      cliVersion: "1.2.3",
    });
    expect(send.mock.calls[0]?.[1]).toMatchObject({ auto: true, failureCode: "machine_revoked" });
    expect(writeReportFile.mock.calls[0]?.[0]).toContain(
      path.join(home, "diagnostic-reports"),
    );

    // No renderer here, so the send waits to be shown rather than vanishing.
    expect(listPendingAutoDiagnosticsNotices(stateFilePath)).toEqual([
      {
        failureCode: "machine_revoked",
        reportPath: writeReportFile.mock.calls[0]?.[0] ?? null,
        reference: "abcd1234",
      },
    ]);
  });

  it("shares the desktop's off switch", async () => {
    const home = adeHome();
    setAutoDiagnosticsEnabled(resolveAutoDiagnosticsStateFile(home, { ADE_HOME: home }), false, {
      now: () => T0,
    });
    const { sender, send } = harness({ home });

    await expect(sender.report({ failureCode: "snapshot_failed", surface: "account_publisher" }))
      .resolves.toBe("skipped_disabled");
    expect(send).not.toHaveBeenCalled();
  });

  it("shares the desktop's daily budget rather than keeping its own", async () => {
    const { sender, send, stateFilePath } = harness();

    await expect(sender.report({ failureCode: "snapshot_failed", surface: "account_publisher" }))
      .resolves.toBe("completed");
    await expect(sender.report({ failureCode: "snapshot_failed", surface: "account_publisher" }))
      .resolves.toBe("skipped_budget");
    expect(send).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stateFilePath)).toBe(true);
  });

  /**
   * The sync host's storage fault reaches this sender directly rather than
   * through the account publisher, because a brain that cannot start a sync
   * host never takes the lease that would give it a publisher. What the sender
   * has to hold up in return is the ceiling: the fault repeats every 30 seconds
   * for as long as the provider refuses, all day.
   */
  it("sends one report for a storage fault that repeats all day", async () => {
    const { sender, send } = harness();
    const request = { failureCode: "storage_read_failed", surface: "sync_host_storage" } as const;

    await expect(sender.report(request)).resolves.toBe("completed");
    for (let repeat = 0; repeat < 5; repeat += 1) {
      await expect(sender.report(request)).resolves.toBe("skipped_budget");
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ failureCode: "storage_read_failed" });
  });

  it("treats a refused upload as a silent skip and offers no toast for it", async () => {
    const { sender, stateFilePath } = harness({ sendResult: { ok: false, reason: "rate_limited" } });

    await expect(sender.report({ failureCode: "snapshot_failed", surface: "account_publisher" }))
      .resolves.toBe("failed");
    // Nothing succeeded, so there is nothing to tell the user about.
    expect(listPendingAutoDiagnosticsNotices(stateFilePath)).toEqual([]);
  });
});
