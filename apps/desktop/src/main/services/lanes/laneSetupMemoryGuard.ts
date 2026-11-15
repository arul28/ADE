import fs from "node:fs";
import { spawn } from "node:child_process";

/**
 * Stops a lane setup command on an ADE Cloud computer before it takes the
 * computer's last memory.
 *
 * A cloud computer has no swap, and when its memory runs out the provider
 * restarts the whole computer, brain included; the setup then runs again and
 * fills it again. `npm ci` from a warm cache does exactly that on a 4 GB
 * computer (it holds the unpacked packages in memory, 3.6 GB+ for ADE's own
 * desktop app, where a Mac peaks at 0.7 GB). The guard is a separate `sh`
 * process, not a brain timer: the brain's event loop lags seconds while a
 * setup saturates the CPUs, and memory falls ~150 MB a second.
 */

export type SetupMemoryStop = { availableMb: number; totalMb: number };

export type SetupMemoryGuard = {
  /** Resolves once the guard has exited (it does as soon as the command's process group is gone), at most `waitMs` later. */
  settled(waitMs: number): Promise<void>;
  /** What the guard saw when it stopped the command; null when it never did. */
  stopped(): SetupMemoryStop | null;
  dispose(): void;
};

const MB = 1024;

/** Free memory below which setup is stopped: a tenth of the computer's memory, between 256 MB and 1 GB. */
export function setupMemoryFloorKb(totalKb: number): number {
  return Math.round(Math.min(1024 * MB, Math.max(256 * MB, totalKb / 10)));
}

// $1 the process group, $2 the floor in KB. Prints what was free, then kills the group.
const GUARD_SCRIPT = [
  'pg=$1; floor=$2',
  'while kill -0 -"$pg" 2>/dev/null; do',
  '  a=$(awk \'/^MemAvailable:/{print $2; exit}\' /proc/meminfo)',
  '  if [ -n "$a" ] && [ "$a" -lt "$floor" ]; then echo "$a"; kill -KILL -"$pg" 2>/dev/null; exit 0; fi',
  '  sleep 0.5',
  'done',
].join("\n");

function readMemTotalKb(): number | null {
  try {
    const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Watches the process group `pgid` (a setup command spawned detached) on an
 * ADE Cloud computer; null anywhere else, where the OS has swap and a memory
 * spike slows the machine instead of restarting it.
 */
export function watchSetupMemory(
  pgid: number | undefined,
  options: { onCloudComputer?: boolean; onError?: (error: unknown) => void } = {},
): SetupMemoryGuard | null {
  const onCloudComputer = options.onCloudComputer ?? Boolean(process.env.ADE_CLOUD_INSTANCE_ID?.trim());
  if (process.platform !== "linux" || !onCloudComputer || !pgid || pgid <= 0) return null;
  const totalKb = readMemTotalKb();
  if (!totalKb) return null;

  let output = "";
  let stop: SetupMemoryStop | null = null;
  let exited = false;
  const waiters: Array<() => void> = [];
  const guard = spawn("sh", ["-c", GUARD_SCRIPT, "ade-setup-memory-guard", String(pgid), String(setupMemoryFloorKb(totalKb))], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const finish = () => {
    if (exited) return;
    exited = true;
    const availableKb = Number(output.trim().split(/\s+/)[0]);
    if (output.trim() && Number.isFinite(availableKb)) {
      stop = { availableMb: Math.round(availableKb / MB), totalMb: Math.round(totalKb / MB) };
    }
    for (const wake of waiters.splice(0)) wake();
  };
  guard.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  guard.on("error", (error) => { options.onError?.(error); finish(); });
  guard.on("close", finish);

  return {
    settled: (waitMs) => exited
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      }),
    stopped: () => stop,
    dispose: () => {
      if (!exited) guard.kill("SIGTERM");
    },
  };
}
