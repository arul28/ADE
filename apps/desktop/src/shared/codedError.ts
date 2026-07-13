export type ParsedCodedError = {
  code?: string;
  message: string;
  rootPath?: string;
};

// Electron IPC strips custom Error properties, so the code (and, for
// project-open failures picked in the main process, the target rootPath the
// renderer never saw) travel inside the message. NUL is used as the rootPath
// delimiter because it never appears in a human-readable error message.
const ROOT_PATH_DELIMITER = String.fromCharCode(0);

export function codedError<TCode extends string>(message: string, code: TCode): Error & { code: TCode } {
  return Object.assign(new Error(message), { code });
}

export function encodeCodedErrorMessage(code: string, message: string, meta?: { rootPath?: string }): string {
  const base = `${code}: ${message}`;
  return meta?.rootPath ? `${base}${ROOT_PATH_DELIMITER}${meta.rootPath}` : base;
}

export function stripElectronErrorWrapper(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

export function parseCodedErrorMessage(error: unknown): ParsedCodedError {
  const directCode = (error as { code?: unknown } | null)?.code;
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  // Split rootPath off FIRST, before the wrapper strip trims the string —
  // otherwise a valid path with trailing whitespace would lose it. rootPath is
  // an opaque filesystem path and is preserved byte-for-byte.
  const delimiterIndex = rawMessage.indexOf(ROOT_PATH_DELIMITER);
  const rootPath = delimiterIndex >= 0 ? rawMessage.slice(delimiterIndex + 1) : "";
  const raw = stripElectronErrorWrapper(delimiterIndex >= 0 ? rawMessage.slice(0, delimiterIndex) : rawMessage);
  const match = raw.match(/^([a-z][a-z0-9_]*)\s*:\s*/i);
  const code = typeof directCode === "string" && directCode.length > 0
    ? directCode
    : match?.[1];
  const message = match ? raw.slice(match[0].length).trim() : raw;
  return {
    ...(code ? { code } : {}),
    message,
    ...(rootPath ? { rootPath } : {}),
  };
}

export function extractCodeFromMessage(error: unknown): string | null {
  return parseCodedErrorMessage(error).code ?? null;
}
