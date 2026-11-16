import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * The last line of defence for an ADE Cloud computer's memory.
 *
 * A cloud computer has no swap, and when its memory runs out the provider
 * restarts the whole computer: the brain, every chat turn and every terminal
 * go with it. An agent's `npm install` or a build in a terminal can do that
 * on a Small (4 GB). Like earlyoom, this guard kills the one biggest process
 * instead, never the brain or its workers, so the rest keeps running and the
 * command that did it fails with "Killed".
 *
 * It fires below a twentieth of memory; a lane setup's own guard
 * (`laneSetupMemoryGuard.ts`, a tenth) gets there first and says why. It is
 * a `sh` loop beside the brain, not a brain timer: the brain's event loop
 * lags seconds while something saturates the CPUs, and memory falls fast.
 */

const MB = 1024;

/** Free memory below which the biggest process is killed: a twentieth of memory, between 200 and 512 MB. */
export function cloudMemoryFloorKb(totalKb: number): number {
  return Math.round(Math.min(512 * MB, Math.max(200 * MB, totalKb / 20)));
}

// $1 the brain's pid, $2 the floor in KB. Never kills the brain, its own
// workers (`ade __…`), the entrypoint, the provider's own processes, or itself.
const GUARD_SCRIPT = [
  'brain=$1; floor=$2; me=$$',
  'while kill -0 "$brain" 2>/dev/null; do',
  '  a=$(awk \'/^MemAvailable:/{print $2; exit}\' /proc/meminfo)',
  '  if [ -n "$a" ] && [ "$a" -lt "$floor" ]; then',
  '    victim=$(ps -u "$(id -u)" -o pid=,rss=,args= --sort=-rss | awk -v brain="$brain" -v me="$me" \'',
  '      $1 == brain || $1 == me || $1 == 1 { next }',
  '      / __ade-|ade-entrypoint|tini |agent37|sshd|ade-cloud-memory-guard/ { next }',
  '      { print $1, $2, substr($0, index($0, $3), 160); exit }\')',
  '    if [ -n "$victim" ]; then',
  '      kill -KILL "${victim%% *}" 2>/dev/null && echo "killed $a $victim"',
  '      sleep 2',
  '    fi',
  '  fi',
  '  sleep 0.5',
  'done',
].join("\n");

export type CloudMemoryKill = { pid: number; rssMb: number; availableMb: number; command: string };

/** Parses one line the guard prints: `killed <availableKb> <pid> <rssKb> <command…>`. */
export function parseCloudMemoryKill(line: string): CloudMemoryKill | null {
  const match = /^killed (\d+) (\d+) (\d+) ?(.*)$/.exec(line.trim());
  if (!match) return null;
  return {
    availableMb: Math.round(Number(match[1]) / MB),
    pid: Number(match[2]),
    rssMb: Math.round(Number(match[3]) / MB),
    command: (match[4] ?? "").trim(),
  };
}

function readMemTotalKb(): number | null {
  try {
    const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

type Logger = { warn(event: string, meta?: Record<string, unknown>): void; info?(event: string, meta?: Record<string, unknown>): void };

/** Starts the guard on an ADE Cloud computer (Linux); null anywhere else. Restarts it if it exits while the brain runs. */
export function startCloudMemoryGuard(deps: {
  logger: Logger;
  onKill?: (kill: CloudMemoryKill) => void;
  platform?: NodeJS.Platform;
}): { dispose(): void } | null {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const totalKb = readMemTotalKb();
  if (!totalKb) return null;
  const floorKb = cloudMemoryFloorKb(totalKb);
  let disposed = false;
  let child: ChildProcess | null = null;
  let restartTimer: NodeJS.Timeout | null = null;

  const start = () => {
    if (disposed) return;
    let pending = "";
    const guard = spawn("sh", ["-c", GUARD_SCRIPT, "ade-cloud-memory-guard", String(process.pid), String(floorKb)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child = guard;
    guard.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const kill = parseCloudMemoryKill(line);
        if (!kill) continue;
        deps.logger.warn("cloud.memory_guard_killed", { ...kill, totalMb: Math.round(totalKb / MB) });
        deps.onKill?.(kill);
      }
    });
    guard.on("error", (error) => {
      deps.logger.warn("cloud.memory_guard_failed", { error: error instanceof Error ? error.message : String(error) });
    });
    guard.on("close", (code) => {
      if (child === guard) child = null;
      if (disposed) return;
      deps.logger.warn("cloud.memory_guard_exited", { code });
      restartTimer = setTimeout(start, 5_000);
      restartTimer.unref?.();
    });
  };

  start();
  deps.logger.info?.("cloud.memory_guard_started", { floorMb: Math.round(floorKb / MB), totalMb: Math.round(totalKb / MB) });
  return {
    dispose: () => {
      disposed = true;
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill("SIGTERM");
      child = null;
    },
  };
}
