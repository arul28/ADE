import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "../logging/logger";

const execFileAsync = promisify(execFile);

export type OrphanedAdeAgentProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
};

function isAdeSpawnedCodexExec(command: string): boolean {
  return command.includes("/.ade/worktrees/")
    && (
      /node_modules\/\.bin\/codex\s+exec\b/.test(command)
      || /\/codex(?:\s+|\/codex\s+)exec\b/.test(command)
    );
}

export function parseOrphanedAdeAgentProcesses(stdout: string): OrphanedAdeAgentProcess[] {
  const out: OrphanedAdeAgentProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const pgid = Number.parseInt(match[3], 10);
    const command = match[4];
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(pgid)) continue;
    if (ppid !== 1) continue;
    if (!isAdeSpawnedCodexExec(command)) continue;
    out.push({ pid, ppid, pgid, command });
  }
  return out;
}

export async function recoverOrphanedAdeAgentProcesses(args: {
  logger: Pick<Logger, "warn">;
  processKill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}): Promise<OrphanedAdeAgentProcess[]> {
  if (process.platform === "win32") return [];
  const processKill = args.processKill ?? ((pid: number, signal?: NodeJS.Signals | 0) =>
    process.kill(pid, signal as NodeJS.Signals | undefined));
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { timeout: 2_000 });
    const targets = parseOrphanedAdeAgentProcesses(stdout);
    const killedGroups = new Set<number>();
    for (const proc of targets) {
      const killPid = proc.pgid > 1 ? -proc.pgid : proc.pid;
      if (killPid < 0 && killedGroups.has(proc.pgid)) continue;
      try {
        processKill(killPid, "SIGTERM");
        if (killPid < 0) killedGroups.add(proc.pgid);
        args.logger.warn("agent_process_orphan_recovered", {
          pid: proc.pid,
          ppid: proc.ppid,
          pgid: proc.pgid,
        });
      } catch (error) {
        args.logger.warn("agent_process_orphan_recovery_failed", {
          pid: proc.pid,
          ppid: proc.ppid,
          pgid: proc.pgid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return targets;
  } catch (error) {
    args.logger.warn("agent_process_orphan_scan_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
