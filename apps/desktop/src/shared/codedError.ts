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

/**
 * libuv can only name the errnos it has a mapping for. macOS returns EDEADLK
 * (errno 11) for a File-Provider read it cannot satisfy, which libuv does not
 * map, so the error reaches us as the uninterpretable "Unknown system error
 * -11: Unknown system error -11, read". Anything in that shape is a raw
 * platform failure, never a verdict a service authored.
 */
export const UNKNOWN_SYSTEM_ERRNO_PATTERN = /unknown system error\s+-?\d+/i;

/** libuv/POSIX errno codes: `ENOENT`, `EDEADLK`, `ECONNRESET`, … */
const ERRNO_CODE_PATTERN = /^E[A-Z0-9]+$/;

/**
 * Node's own internal codes: `ERR_MODULE_NOT_FOUND`, `ERR_FS_EISDIR`,
 * `ERR_INVALID_ARG_TYPE`, … plus the one legacy code that predates the prefix.
 *
 * They belong with the errnos and not with service verdicts: their messages are
 * written for whoever is reading a stack trace and routinely quote an absolute
 * path ("Cannot find module '/Users/…'"), so a boundary that treats them as
 * authored copy forwards a filesystem path to a caller that must never see one.
 */
const NODE_INTERNAL_CODE_PATTERN = /^ERR_[A-Z0-9_]+$/;
const LEGACY_NODE_MODULE_NOT_FOUND_CODE = "MODULE_NOT_FOUND";

/**
 * Whether an `Error.code` was attached by the platform rather than chosen by
 * ADE. ADE's own codes are lowercase snake_case (`storage_read_failed`), so the
 * two vocabularies cannot collide.
 */
export function isErrnoLikeCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  const trimmed = code.trim();
  if (!trimmed) return false;
  return ERRNO_CODE_PATTERN.test(trimmed)
    || NODE_INTERNAL_CODE_PATTERN.test(trimmed)
    || trimmed === LEGACY_NODE_MODULE_NOT_FOUND_CODE;
}

export function encodeCodedErrorMessage(code: string, message: string, meta?: { rootPath?: string }): string {
  const base = `${code}: ${message}`;
  return meta?.rootPath ? `${base}${ROOT_PATH_DELIMITER}${meta.rootPath}` : base;
}

export function stripElectronErrorWrapper(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    // The runtime RPC client wraps every daemon-side failure in "Remote ADE
    // service method <m> failed (code <n>): …". A code the brain attached is
    // behind that wrapper, and without stripping it no brain-side failure can
    // ever be recognised by its code — which is how a project whose data files
    // were unreadable reached the user as a raw libuv errno.
    .replace(/^Remote ADE service method \S+ failed(?:\s*\(code -?\d+\))?:\s*/i, "")
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
