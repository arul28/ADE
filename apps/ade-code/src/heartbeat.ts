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
  const stop = () => {
    clearInterval(timer);
    safeUnlink(filePath);
  };
  const stopAndExit = (signal: NodeJS.Signals) => {
    stop();
    process.exit(EXIT_CODES_BY_SIGNAL[signal] ?? 1);
  };
  process.once("exit", stop);
  for (const signal of Object.keys(EXIT_CODES_BY_SIGNAL) as NodeJS.Signals[]) {
    process.once(signal, () => stopAndExit(signal));
  }
  return {
    count: cleanupAndCount(dir),
    stop,
    readCount: () => cleanupAndCount(dir),
  };
}
