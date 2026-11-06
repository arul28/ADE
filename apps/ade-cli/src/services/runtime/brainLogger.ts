import {
  createFileLogger,
  type FileLoggerOptions,
  type Logger,
} from "../../../../desktop/src/main/services/logging/logger";

type BrainLoggerOptions = FileLoggerOptions & {
  now?: () => Date;
  stderr?: Pick<NodeJS.WriteStream, "write"> & Partial<Pick<NodeJS.WriteStream, "on">>;
};

const guardedStreams = new WeakSet<object>();

function serializedMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "";
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " {\"serializationError\":true}";
  }
}

export function createBrainLogger(
  logFilePath: string,
  options: BrainLoggerOptions = {},
): Logger {
  const {
    now = () => new Date(),
    stderr = process.stderr,
    ...fileLoggerOptions
  } = options;
  const fileLogger = createFileLogger(logFilePath, fileLoggerOptions);
  // The stderr copy is a courtesy for whoever watches the brain's terminal.
  // A full disk (ENOSPC) or a closed pipe (EPIPE) on it must never take the
  // brain down: a write that throws is dropped, and an asynchronous failure
  // arrives as a stream 'error' event, which with no listener is fatal (one
  // listener per stream, however many loggers share it). After the first
  // failure this logger's copy stops; the log file keeps every line.
  let stderrBroken = false;
  if (typeof stderr.on === "function" && !guardedStreams.has(stderr)) {
    guardedStreams.add(stderr);
    stderr.on("error", () => {});
  }
  const mirror = (
    level: "warn" | "error",
    event: string,
    meta?: Record<string, unknown>,
  ): void => {
    if (stderrBroken) return;
    try {
      stderr.write(
        `[${now().toISOString()}] ${level.toUpperCase()} ${event}${serializedMeta(meta)}\n`,
        (error) => {
          if (error) stderrBroken = true;
        },
      );
    } catch {
      stderrBroken = true;
    }
  };

  return {
    debug: (event, meta) => fileLogger.debug(event, meta),
    info: (event, meta) => fileLogger.info(event, meta),
    warn: (event, meta) => {
      fileLogger.warn(event, meta);
      mirror("warn", event, meta);
    },
    error: (event, meta) => {
      fileLogger.error(event, meta);
      mirror("error", event, meta);
    },
  };
}
