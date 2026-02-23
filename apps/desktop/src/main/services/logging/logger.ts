import fs from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const ROTATION_CHECK_WRITE_INTERVAL = 1000;
const ROTATION_CHECK_INTERVAL_MS = 60_000;
const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_SIZE = 100;

export type Logger = {
  debug: (event: string, meta?: Record<string, unknown>) => void;
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
  error: (event: string, meta?: Record<string, unknown>) => void;
};

function resolveMinLevel(): number {
  const value = process.env.ADE_LOG_LEVEL?.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return LOG_LEVELS[value];
  }
  return LOG_LEVELS.info;
}

function getRotatedLogFilePath(logFilePath: string): string {
  const parsed = path.parse(logFilePath);
  return path.join(parsed.dir, `${parsed.name}.1${parsed.ext}`);
}

function createConsoleMirror(level: LogLevel, event: string, meta?: Record<string, unknown>) {
  if (!process.env.VITE_DEV_SERVER_URL) return;
  const fn =
    level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
  fn(`[${level}] ${event}`, meta ?? "");
}

export function createFileLogger(logFilePath: string): Logger {
  const minLevel = resolveMinLevel();
  const logDir = path.dirname(logFilePath);
  const rotatedLogFilePath = getRotatedLogFilePath(logFilePath);

  let writesSinceRotateCheck = 0;
  let lastRotateCheckAt = Date.now();
  let estimatedFileSize: number | null = null;
  let queuedLines: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushInProgress = false;
  let flushRequested = false;

  const shouldCheckRotation = (): boolean => {
    if (writesSinceRotateCheck >= ROTATION_CHECK_WRITE_INTERVAL) return true;
    return Date.now() - lastRotateCheckAt >= ROTATION_CHECK_INTERVAL_MS;
  };

  const refreshEstimatedFileSizeIfNeeded = async (): Promise<void> => {
    if (estimatedFileSize != null && !shouldCheckRotation()) return;
    writesSinceRotateCheck = 0;
    lastRotateCheckAt = Date.now();

    try {
      const stat = await fs.promises.stat(logFilePath);
      estimatedFileSize = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        estimatedFileSize = 0;
        return;
      }
      throw err;
    }
  };

  const rotateIfNeeded = async (upcomingWriteBytes: number): Promise<void> => {
    await refreshEstimatedFileSizeIfNeeded();
    const currentFileSize = estimatedFileSize ?? 0;
    if (currentFileSize < MAX_LOG_FILE_BYTES && currentFileSize + upcomingWriteBytes <= MAX_LOG_FILE_BYTES) return;

    try {
      await fs.promises.unlink(rotatedLogFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    try {
      await fs.promises.rename(logFilePath, rotatedLogFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    await fs.promises.writeFile(logFilePath, "", "utf8");
    estimatedFileSize = 0;
  };

  const flush = async (): Promise<void> => {
    if (flushInProgress) {
      flushRequested = true;
      return;
    }
    if (queuedLines.length === 0) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const lines = queuedLines.splice(0, FLUSH_BATCH_SIZE);
    const payload = lines.join("");
    const bytes = Buffer.byteLength(payload, "utf8");
    flushInProgress = true;

    try {
      await fs.promises.mkdir(logDir, { recursive: true });
      await rotateIfNeeded(bytes);
      await fs.promises.appendFile(logFilePath, payload, "utf8");
      estimatedFileSize = (estimatedFileSize ?? 0) + bytes;
    } catch {
      // Last ditch: avoid crashing the app on log write failures.
    } finally {
      flushInProgress = false;
      if (flushRequested || queuedLines.length > 0) {
        flushRequested = false;
        void flush();
      }
    }
  };

  const scheduleFlush = () => {
    if (queuedLines.length >= FLUSH_BATCH_SIZE) {
      void flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
  };

  const writeLine = (level: LogLevel, event: string, meta?: Record<string, unknown>) => {
    if (LOG_LEVELS[level] < minLevel) return;

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(meta ? { meta } : {})
    });

    const payload = `${line}\n`;
    queuedLines.push(payload);
    writesSinceRotateCheck += 1;
    scheduleFlush();
    createConsoleMirror(level, event, meta);
  };

  return {
    debug: (event, meta) => writeLine("debug", event, meta),
    info: (event, meta) => writeLine("info", event, meta),
    warn: (event, meta) => writeLine("warn", event, meta),
    error: (event, meta) => writeLine("error", event, meta)
  };
}
