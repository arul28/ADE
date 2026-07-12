export type ParsedCodedError = {
  code?: string;
  message: string;
};

export function codedError<TCode extends string>(message: string, code: TCode): Error & { code: TCode } {
  return Object.assign(new Error(message), { code });
}

export function encodeCodedErrorMessage(code: string, message: string): string {
  return `${code}: ${message}`;
}

export function stripElectronErrorWrapper(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

export function parseCodedErrorMessage(error: unknown): ParsedCodedError {
  const directCode = (error as { code?: unknown } | null)?.code;
  const raw = stripElectronErrorWrapper(error instanceof Error ? error.message : String(error ?? ""));
  const match = raw.match(/^([a-z][a-z0-9_]*)\s*:\s*/i);
  const code = typeof directCode === "string" && directCode.length > 0
    ? directCode
    : match?.[1];
  const message = match ? raw.slice(match[0].length).trim() : raw;
  return {
    ...(code ? { code } : {}),
    message,
  };
}

export function extractCodeFromMessage(error: unknown): string | null {
  return parseCodedErrorMessage(error).code ?? null;
}
