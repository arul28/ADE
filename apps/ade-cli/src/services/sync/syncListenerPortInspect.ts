import { execFile } from "node:child_process";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import {
  buildWindowsPortHolderQueryArgs,
  parseWindowsPortHolders,
  type WindowsPortHolder,
} from "./windowsPortHolders";

export type SyncListenerPortDiagnosis = {
  port: number;
  holders: WindowsPortHolder[];
};

// Bounded so a hung lsof/ps cannot stall the preferred-port reclaim loop.
const PORT_INSPECT_TIMEOUT_MS = 200;
// PowerShell cold-starts on Windows. Keep this longer than the POSIX probe so
// doctor / reclaim still see holders instead of timing out into "nothing".
const WINDOWS_PORT_INSPECT_TIMEOUT_MS = 5_000;

export function execFileText(
  command: string,
  args: string[],
  timeoutMs: number = PORT_INSPECT_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error ? null : String(stdout ?? ""));
      },
    );
  });
}

async function inspectWindowsSyncListenerPort(
  port: number,
  exec: typeof execFileText,
): Promise<SyncListenerPortDiagnosis> {
  let powershell: string;
  let args: string[];
  try {
    powershell = resolveTrustedWindowsTool("powershell");
    args = buildWindowsPortHolderQueryArgs(port);
  } catch {
    return { port, holders: [] };
  }
  const raw = await exec(powershell, args, WINDOWS_PORT_INSPECT_TIMEOUT_MS);
  return { port, holders: parseWindowsPortHolders(raw) };
}

async function inspectPosixSyncListenerPort(
  port: number,
  exec: typeof execFileText,
): Promise<SyncListenerPortDiagnosis> {
  const lsof = await exec(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
  );
  if (lsof == null) return { port, holders: [] };
  const pids = [...new Set(
    lsof
      .split(/\r?\n/)
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number(line.slice(1)))
      .filter((pid) => Number.isFinite(pid) && pid > 0),
  )];
  return {
    port,
    holders: await Promise.all(pids.map(async (pid) => {
      const [commandResult, startResult] = await Promise.all([
        exec("ps", ["-p", String(pid), "-o", "command="]),
        exec("ps", ["-p", String(pid), "-o", "lstart="]),
      ]);
      const command = commandResult?.trim() ?? "";
      const startTime = startResult?.trim() ?? "";
      return {
        pid,
        command: command || null,
        startTime: startTime || null,
      };
    })),
  };
}

/**
 * Processes listening on `port`, dispatched per platform.
 *
 * Both consumers degrade badly when this silently answers "nothing": the
 * stale-port reclaim in `createSharedSyncListener` cannot recognise a wedged
 * same-channel sibling and permanently drifts mobile sync onto a fallback port,
 * and `ade doctor` reports "no holders visible to this user" with advice that
 * only makes sense on macOS.
 */
export async function inspectSyncListenerPort(
  port: number,
  deps: {
    platform?: NodeJS.Platform;
    exec?: typeof execFileText;
  } = {},
): Promise<SyncListenerPortDiagnosis> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? execFileText;
  return platform === "win32"
    ? inspectWindowsSyncListenerPort(port, exec)
    : inspectPosixSyncListenerPort(port, exec);
}
