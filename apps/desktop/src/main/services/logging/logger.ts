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
const FLUSH_BATCH_SIZE = 500;

export type FileLoggerOptions = {
  maxFileBytes?: number;
  rotationCheckWriteInterval?: number;
  rotationCheckIntervalMs?: number;
  flushIntervalMs?: number;
  flushBatchSize?: number;
};

export type Logger = {
  debug: (event: string, meta?: Record<string, unknown>) => void;
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
  error: (event: string, meta?: Record<string, unknown>) => void;
  // Writes anything still queued straight to disk. Normal logging batches
  // through an async stream, so a caller that is about to end the process
  // (app.exit, force quit) must call this or its last records are lost —
  // exactly the records that explain why the process died.
  flushSync?: () => void;
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

const CONSOLE_FN_BY_LEVEL: Record<LogLevel, typeof console.log> = {
  error: console.error,
  warn: console.warn,
  debug: console.debug,
  info: console.log,
};

function createConsoleMirror(level: LogLevel, event: string, meta?: Record<string, unknown>) {
  if (!process.env.VITE_DEV_SERVER_URL) return;
  if (process.env.ADE_STDIO_TRANSPORT === "1") return;
  if (!process.stdout.isTTY) return;
  CONSOLE_FN_BY_LEVEL[level](`[${level}] ${event}`, meta ?? "");
}

export function createFileLogger(
  logFilePath: string,
  options: FileLoggerOptions = {},
): Logger {
  const minLevel = resolveMinLevel();
  const logDir = path.dirname(logFilePath);
  const rotatedLogFilePath = getRotatedLogFilePath(logFilePath);
  const maxFileBytes = options.maxFileBytes ?? MAX_LOG_FILE_BYTES;
  const rotationCheckWriteInterval = options.rotationCheckWriteInterval
    ?? ROTATION_CHECK_WRITE_INTERVAL;
  const rotationCheckIntervalMs = options.rotationCheckIntervalMs
    ?? ROTATION_CHECK_INTERVAL_MS;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const flushBatchSize = options.flushBatchSize ?? FLUSH_BATCH_SIZE;

  let writesSinceRotateCheck = 0;
  let lastRotateCheckAt = Date.now();
  let estimatedFileSize: number | null = null;
  let queuedLines: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushInProgress = false;
  let flushRequested = false;
  let logDirReady = false;
  let logStream: fs.WriteStream | null = null;

  const shouldCheckRotation = (): boolean => {
    if (writesSinceRotateCheck >= rotationCheckWriteInterval) return true;
    return Date.now() - lastRotateCheckAt >= rotationCheckIntervalMs;
  };

  const ensureLogDir = (): boolean => {
    if (logDirReady) return true;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      logDirReady = true;
      return true;
    } catch {
      return false;
    }
  };

  const refreshEstimatedFileSizeIfNeeded = (): void => {
    if (estimatedFileSize != null && !shouldCheckRotation()) return;
    writesSinceRotateCheck = 0;
    lastRotateCheckAt = Date.now();

    try {
      const stat = fs.statSync(logFilePath);
      estimatedFileSize = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        estimatedFileSize = 0;
        return;
      }
      throw err;
    }
  };

  const closeLogStream = (): Promise<void> => new Promise((resolve) => {
    const stream = logStream;
    if (!stream) {
      resolve();
      return;
    }
    logStream = null;
    stream.end(() => resolve());
  });

  const rotateIfNeeded = async (upcomingWriteBytes: number): Promise<void> => {
    refreshEstimatedFileSizeIfNeeded();
    const currentFileSize = estimatedFileSize ?? 0;
    if (currentFileSize < maxFileBytes && currentFileSize + upcomingWriteBytes <= maxFileBytes) return;

    await closeLogStream();

    try {
      fs.unlinkSync(rotatedLogFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    try {
      fs.renameSync(logFilePath, rotatedLogFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    estimatedFileSize = 0;
  };

  const getLogStream = (): fs.WriteStream | null => {
    if (!ensureLogDir()) return null;
    if (logStream) return logStream;
    const stream = fs.createWriteStream(logFilePath, { flags: "a" });
    stream.on("error", () => {
      if (logStream === stream) {
        logStream = null;
      }
      stream.destroy();
    });
    logStream = stream;
    return stream;
  };

  const writePayload = (payload: string): Promise<void> => new Promise((resolve) => {
    const stream = getLogStream();
    if (!stream) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off("error", finish);
      resolve();
    };
    stream.once("error", finish);
    stream.write(payload, "utf8", finish);
  });

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

    const lines = queuedLines.splice(0, flushBatchSize);
    const payload = lines.join("");
    const bytes = Buffer.byteLength(payload, "utf8");
    flushInProgress = true;

    try {
      if (!ensureLogDir()) return;
      await rotateIfNeeded(bytes);
      await writePayload(payload);
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
    if (queuedLines.length >= flushBatchSize) {
      void flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushIntervalMs);
    flushTimer.unref?.();
  };

  // Lines already handed to an in-flight async flush have been spliced out of
  // queuedLines, so draining the rest here cannot duplicate them. Rotation is
  // skipped deliberately: this runs on the way out of the process, where a
  // slightly oversized log beats a lost one.
  const flushSync = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queuedLines.length === 0) return;
    const payload = queuedLines.splice(0, queuedLines.length).join("");
    try {
      if (!ensureLogDir()) return;
      fs.appendFileSync(logFilePath, payload);
      estimatedFileSize = (estimatedFileSize ?? 0) + Buffer.byteLength(payload, "utf8");
    } catch {
      // Same contract as flush(): never crash the app over a log write.
    }
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
    error: (event, meta) => writeLine("error", event, meta),
    flushSync
  };
}
