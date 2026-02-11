import fs from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (event: string, meta?: Record<string, unknown>) => void;
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
  error: (event: string, meta?: Record<string, unknown>) => void;
};

function writeLine(logFilePath: string, level: LogLevel, event: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(meta ? { meta } : {})
  });

  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
  } catch {
    // Last ditch: avoid crashing the app on log write failures.
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    // Keep dev feedback tight without relying solely on the log file.
    const fn =
      level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
    fn(`[${level}] ${event}`, meta ?? "");
  }
}

export function createFileLogger(logFilePath: string): Logger {
  return {
    debug: (event, meta) => writeLine(logFilePath, "debug", event, meta),
    info: (event, meta) => writeLine(logFilePath, "info", event, meta),
    warn: (event, meta) => writeLine(logFilePath, "warn", event, meta),
    error: (event, meta) => writeLine(logFilePath, "error", event, meta)
  };
}

