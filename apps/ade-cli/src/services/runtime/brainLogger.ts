import {
  createFileLogger,
  type FileLoggerOptions,
  type Logger,
} from "../../../../desktop/src/main/services/logging/logger";

type BrainLoggerOptions = FileLoggerOptions & {
  now?: () => Date;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};

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
  const mirror = (
    level: "warn" | "error",
    event: string,
    meta?: Record<string, unknown>,
  ): void => {
    stderr.write(
      `[${now().toISOString()}] ${level.toUpperCase()} ${event}${serializedMeta(meta)}\n`,
    );
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
