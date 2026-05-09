import fs from "node:fs";
import path from "node:path";

const STALE_MS = 20_000;

export type TuiHeartbeat = {
  count: number;
  stop: () => void;
  readCount: () => number;
};

const EXIT_CODES_BY_SIGNAL: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const EXIT_SIGNALS = Object.keys(EXIT_CODES_BY_SIGNAL) as NodeJS.Signals[];
const activeHeartbeatCleanups = new Set<() => void>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let processHandlersRegistered = false;

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function cleanupAndCount(dir: string, now = Date.now()): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { updatedAt?: number; pid?: number };
      const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;
      const pid = typeof raw.pid === "number" ? raw.pid : 0;
      const stale = now - updatedAt > STALE_MS || (pid > 0 && pid !== process.pid && !processExists(pid));
      if (stale) {
        safeUnlink(filePath);
      } else {
        count += 1;
      }
    } catch {
      safeUnlink(filePath);
    }
  }
  return count;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupActiveHeartbeats(): void {
  for (const cleanup of Array.from(activeHeartbeatCleanups)) {
    cleanup();
  }
}

function onProcessExit(): void {
  cleanupActiveHeartbeats();
}

function ensureProcessHandlers(): void {
  if (processHandlersRegistered) return;
  process.once("exit", onProcessExit);
  for (const signal of EXIT_SIGNALS) {
    const handler = () => {
      cleanupActiveHeartbeats();
      process.exit(EXIT_CODES_BY_SIGNAL[signal] ?? 1);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  processHandlersRegistered = true;
}

function removeProcessHandlersIfIdle(): void {
  if (!processHandlersRegistered || activeHeartbeatCleanups.size > 0) return;
  process.removeListener("exit", onProcessExit);
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.clear();
  processHandlersRegistered = false;
}

export function startTuiHeartbeat(projectRoot: string): TuiHeartbeat {
  const dir = path.join(projectRoot, ".ade", "cache", "ade-code", "clients");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${process.pid}.json`);
  const startedAt = new Date().toISOString();
  const write = () => {
    fs.writeFileSync(filePath, JSON.stringify({
      pid: process.pid,
      startedAt,
      updatedAt: Date.now(),
    }), "utf8");
  };
  write();
  const timer = setInterval(() => {
    write();
    cleanupAndCount(dir);
  }, 5_000);
  timer.unref?.();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    activeHeartbeatCleanups.delete(stop);
    safeUnlink(filePath);
    removeProcessHandlersIfIdle();
  };
  activeHeartbeatCleanups.add(stop);
  ensureProcessHandlers();
  return {
    count: cleanupAndCount(dir),
    stop,
    readCount: () => cleanupAndCount(dir),
  };
}
