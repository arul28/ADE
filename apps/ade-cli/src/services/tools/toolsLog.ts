/**
 * The logger the tools cache reports through, installed by the process that
 * turns tool fetches on (`enablePinnedToolFetch`). A module of its own so the
 * layout, eviction and install code can log without importing the download
 * stack. Null until then: a test or a one-shot CLI read logs nothing.
 */
export type ToolsLogger = {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
};

let logger: ToolsLogger | null = null;

export function setToolsLogger(next: ToolsLogger | null): void {
  logger = next;
}

export function warnTools(event: string, fields: Record<string, unknown>): void {
  logger?.warn(event, fields);
}

export function toolsLoggerInstalled(): boolean {
  return logger !== null;
}
