import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainAutoDiagnosticsNotices,
  resolveAutoDiagnosticsStateFile,
  setAutoDiagnosticsEnabled,
} from "../../../../desktop/src/main/services/diagnostics/autoDiagnosticsStore";
import { createBrainAutoDiagnostics } from "./autoDiagnosticsSender";

const dirs: string[] = [];
const T0 = Date.parse("2026-08-19T10:00:00.000Z");

function adeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-auto-diagnostics-"));
  dirs.push(dir);
  return dir;
}

type SendResult = { ok: true; id: string; reference: string } | { ok: false; reason: string };

function harness(options: { home?: string; sendResult?: SendResult } = {}) {
  const home = options.home ?? adeHome();
  const env = { ADE_HOME: home } as NodeJS.ProcessEnv;
  const stateFilePath = resolveAutoDiagnosticsStateFile(home, env);
  const send = vi.fn(async (
    _built: unknown,
    _deps?: { auto?: boolean; failureCode?: string | null },
  ) => options.sendResult ?? { ok: true as const, id: "abcd1234-rest", reference: "abcd1234" });
  const build = vi.fn((_options: { surface?: string; code?: string | null; cliVersion?: string | null }) => ({
    report: "# brain report",
    issueUrl: "https://example.invalid/issue",
    installId: "install-1",
    appVersion: "1.2.3",
    secretsDir: path.join(home, "secrets"),
  }));
  const writeReportFile = vi.fn((_filePath: string, _report: string) => true);
  const sender = createBrainAutoDiagnostics({
    env,
    cliVersion: "1.2.3",
    now: () => T0,
    build: build as never,
    send: send as never,
    writeReportFile,
  });
  return { sender, stateFilePath, send, build, writeReportFile, home };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createBrainAutoDiagnostics", () => {
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
    expect(drainAutoDiagnosticsNotices(stateFilePath, { now: () => T0 })).toEqual([
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

  it("treats a refused upload as a silent skip and offers no toast for it", async () => {
    const { sender, stateFilePath } = harness({ sendResult: { ok: false, reason: "rate_limited" } });

    await expect(sender.report({ failureCode: "snapshot_failed", surface: "account_publisher" }))
      .resolves.toBe("failed");
    // Nothing succeeded, so there is nothing to tell the user about.
    expect(drainAutoDiagnosticsNotices(stateFilePath, { now: () => T0 })).toEqual([]);
  });
});
