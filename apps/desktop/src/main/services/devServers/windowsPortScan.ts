import { execFile } from "node:child_process";

import type { Logger } from "../logging/logger";
import { resolveWindowsPortScanBinary } from "../native/nativeHelperPaths";
import { execFileOffThread, offThreadSpawnEnabled } from "../shared/offThreadSpawn";

/**
 * Windows listener and process reads through `ade-port-scan.exe`
 * (native/ADEPortScanWin) instead of a new PowerShell per read.
 *
 * Measured on a Ryzen 9 7950X3D (see docs/perf/windows-baseline.md): the full
 * listener scan cost about 1.3 s of wall time and 1 s of CPU through
 * PowerShell; the helper prints the same JSON in a few milliseconds. Each
 * mode's output has the shape of the PowerShell query it replaces, so callers
 * parse either the same way.
 *
 * Null means "use PowerShell": the helper is not on disk (an unbuilt dev tree,
 * a standalone brain with no installed app) or it failed. The first fallback
 * in a process is logged; the helper is tried again on the next read, since a
 * timeout on a loaded PC is not a reason to give it up.
 */

const HELPER_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

let binary: string | null | undefined;
let lastRunFailed = false;
let fallbackLogged = false;

function helperBinary(): string | null {
  if (binary === undefined) binary = resolveWindowsPortScanBinary();
  return binary;
}

/** Whether reads go through the helper: it is on disk and its last run worked. */
export function windowsNativePortScanAvailable(): boolean {
  return helperBinary() !== null && !lastRunFailed;
}

function logFallbackOnce(logger: Pick<Logger, "warn"> | null | undefined, reason: string, detail: Record<string, unknown> = {}): void {
  if (fallbackLogged || !logger) return;
  fallbackLogged = true;
  logger.warn("dev_servers.native_scan_fallback", { reason, ...detail });
}

function run(command: string, args: string[]): Promise<{ stdout: string; error: string | null }> {
  if (offThreadSpawnEnabled()) {
    // CreateProcess blocks the calling thread on Windows; keep it off the brain's loop.
    return execFileOffThread(command, args, { timeoutMs: HELPER_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }).then((result) => ({
      stdout: result.stdout,
      error: result.error
        ? result.error.message
        : result.exitCode !== 0
          ? `exit ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`
          : null,
    }));
  }
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          error: error ? `${error.message}${stderr ? `: ${String(stderr).trim().slice(0, 300)}` : ""}` : null,
        });
      },
    );
  });
}

/**
 * One helper read: `["listeners"]`, `["port", "<n>"]` or `["processes"]`.
 * Resolves to the printed JSON array, or null when the caller should ask
 * PowerShell instead.
 */
export async function runWindowsPortScan(
  args: string[],
  logger?: Pick<Logger, "warn"> | null,
): Promise<unknown[] | null> {
  const command = helperBinary();
  if (!command) {
    logFallbackOnce(logger, "helper_missing");
    return null;
  }
  const { stdout, error } = await run(command, args);
  let parsed: unknown = null;
  if (!error) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Reported below as unparsable output.
    }
  }
  if (!Array.isArray(parsed)) {
    lastRunFailed = true;
    logFallbackOnce(logger, error ? "helper_failed" : "helper_output_unparsable", {
      mode: args[0],
      ...(error ? { error } : { bytes: stdout.length }),
    });
    return null;
  }
  lastRunFailed = false;
  return parsed;
}
