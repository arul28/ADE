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
  const withRoot = stripElectronErrorWrapper(error instanceof Error ? error.message : String(error ?? ""));
  const delimiterIndex = withRoot.indexOf(ROOT_PATH_DELIMITER);
  const raw = delimiterIndex >= 0 ? withRoot.slice(0, delimiterIndex) : withRoot;
  const rootPath = delimiterIndex >= 0 ? withRoot.slice(delimiterIndex + 1).trim() : "";
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
