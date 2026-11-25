import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  CloudMemoryKillAnswer,
  CloudMemoryKillReport,
} from "../../../../desktop/src/main/services/adeCloud/cloudMemoryKillNotice";

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
// Before the kill it reads the victim's `ADE_CHAT_SESSION_ID`: every chat's
// agent process and the commands it runs carry it (`buildAgentRuntimeEnv`),
// so the brain can tell that chat. A dead process's environment is gone.
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
  '      pid=${victim%% *}',
  '      chat=$(tr "\\000" "\\n" < "/proc/$pid/environ" 2>/dev/null | awk -F= \'$1 == "ADE_CHAT_SESSION_ID" { print $2; exit }\')',
  '      kill -KILL "$pid" 2>/dev/null && echo "killed $a ${chat:--} $victim"',
  '      sleep 2',
  '    fi',
  '  fi',
  '  sleep 0.5',
  'done',
].join("\n");

export type CloudMemoryKill = {
  pid: number;
  rssMb: number;
  availableMb: number;
  command: string;
  /** The chat the process belonged to (its `ADE_CHAT_SESSION_ID`), or null. */
  chatSessionId: string | null;
};

const CHAT_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Parses one line the guard prints: `killed <availableKb> <chat session id|-> <pid> <rssKb> <command…>`. */
export function parseCloudMemoryKill(line: string): CloudMemoryKill | null {
  const match = /^killed (\d+) (\S+) (\d+) (\d+) ?(.*)$/.exec(line.trim());
  if (!match) return null;
  const chat = match[2] ?? "-";
  return {
    availableMb: Math.round(Number(match[1]) / MB),
    chatSessionId: CHAT_SESSION_ID.test(chat) ? chat : null,
    pid: Number(match[3]),
    rssMb: Math.round(Number(match[4]) / MB),
    command: (match[5] ?? "").trim(),
  };
}

/** What the chat service answers (`reportCloudMemoryKill` in `agentChatService.ts`). */
type MemoryKillChatService = {
  reportCloudMemoryKill?: (kill: CloudMemoryKillReport) => CloudMemoryKillAnswer;
};

const NO_ANSWER: CloudMemoryKillAnswer = { told: 0, notAChat: false };

/**
 * Tells the chats on this computer about one kill, across every runtime the
 * brain has booted: the chat the process belonged to, else (no chat id, or a
 * chat none of them has) every chat with a running turn. A chat id that names
 * a session that is not a chat (a tracked agent CLI's terminal) tells nobody:
 * the CLI gets no notice, its terminal shows "Killed". Each chat service
 * holds a burst of kills to one notice a minute. Returns the chats told.
 */
export function tellChatsOfCloudMemoryKill(
  runtimes: ReadonlyArray<{ agentChatService?: MemoryKillChatService | null }>,
  kill: CloudMemoryKill & { totalMb: number },
  logger: Logger,
): number {
  const tell = (sessionId: string | null): CloudMemoryKillAnswer => runtimes.reduce((sum, runtime) => {
    try {
      const answer = runtime.agentChatService?.reportCloudMemoryKill?.({
        sessionId,
        pid: kill.pid,
        rssMb: kill.rssMb,
        totalMb: kill.totalMb,
        command: kill.command,
      });
      return answer ? { told: sum.told + answer.told, notAChat: sum.notAChat || answer.notAChat } : sum;
    } catch (error) {
      logger.warn("cloud.memory_guard_tell_failed", { error: error instanceof Error ? error.message : String(error) });
      return sum;
    }
  }, NO_ANSWER);
  const own = kill.chatSessionId ? tell(kill.chatSessionId) : NO_ANSWER;
  const told = own.told > 0 || own.notAChat ? own.told : tell(null).told;
  logger.info?.("cloud.memory_guard_told_chats", {
    pid: kill.pid,
    told,
    byChatId: own.told > 0,
    hadChatId: kill.chatSessionId != null,
    ownerNotAChat: own.notAChat,
  });
  return told;
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
  /** Each kill, with this computer's memory (`tellChatsOfCloudMemoryKill`). */
  onKill?: (kill: CloudMemoryKill & { totalMb: number }) => void;
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
        const totalMb = Math.round(totalKb / MB);
        deps.logger.warn("cloud.memory_guard_killed", { ...kill, totalMb });
        try {
          deps.onKill?.({ ...kill, totalMb });
        } catch (error) {
          deps.logger.warn("cloud.memory_guard_on_kill_failed", { error: error instanceof Error ? error.message : String(error) });
        }
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
