import { UNKNOWN_SYSTEM_ERRNO_PATTERN } from "../../../shared/codedError";
import {
  detectCloudStorageProvider,
  storageUnreadableMessage,
  storageUnreadableRemedy,
  type CloudStorageProvider,
} from "./cloudPlaceholder";

/**
 * Telling "the bytes are not readable here" apart from every other failure.
 *
 * A sync host that cannot read its own data files fails the same way forever:
 * the file is a cloud placeholder the provider will not materialize, the disk
 * is failing, or a network mount is gone. Retrying that on a raw two-second
 * cadence and logging the platform's own words is what put "Unknown system
 * error -11" in front of a user with nothing to act on.
 *
 * This is the one place the app decides that question. `classifySqliteOpenError`
 * (desktop `state/kvDb.ts`) calls straight into it at the database-open site;
 * callers with no database in hand get the same judgement, plus the path and
 * the provider so they can say WHICH file and WHERE it lives.
 */

/**
 * Errnos that mean the filesystem refused to hand over the bytes.
 *
 * macOS returns EDEADLK for a File-Provider read it cannot satisfy — the
 * original incident. EIO, ENXIO, ENODEV and EREMOTEIO are the failing-device
 * and dead-mount shapes, ESTALE and EHOSTDOWN the dropped-network-mount ones.
 * All of them appear on Windows too, because libuv maps the Win32 equivalents
 * (ERROR_DEV_NOT_EXIST, ERROR_NOT_READY, …) onto the same POSIX names.
 *
 * None of them counts on its own: the socket layer raises several of the same
 * names. See `hasFilesystemEvidence`.
 */
export const STORAGE_FAULT_ERRNO_CODES: ReadonlySet<string> = new Set([
  "EDEADLK",
  "EIO",
  "ENXIO",
  "ENODEV",
  "ESTALE",
  "EHOSTDOWN",
  "EREMOTEIO",
]);

/**
 * Windows on-demand files have no POSIX name at all. A OneDrive placeholder
 * that cannot be hydrated fails with an `ERROR_CLOUD_FILE_*` status (and an
 * archived file with `ERROR_FILE_OFFLINE`); libuv maps none of them, so Node
 * reports the catch-all `UNKNOWN` code with a negative Win32 errno.
 *
 * `UNKNOWN` on its own is far too broad to call a storage fault — it is what
 * every unmapped Win32 error becomes. It counts only when the file also sits
 * inside a cloud-provider folder, which is the same both-signals-agree rule
 * `detectCloudPlaceholderFile` uses before it refuses a boot.
 */
const WINDOWS_UNMAPPED_ERRNO_CODE = "UNKNOWN";

export type StorageFault = {
  /** The `storage_read_failed` convention, shared with the database-open path. */
  code: "storage_read_failed";
  /** The platform's own code, when it named one. Diagnostics only. */
  errno: string | null;
  /** The file that could not be read, when the failure named one. */
  path: string | null;
  provider: CloudStorageProvider | null;
  /** The sentence a person can act on. Never the platform's words. */
  message: string;
};

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function readErrorPath(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { path?: unknown }).path;
  return typeof value === "string" && value.trim() ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Whether anything besides the errno says a FILE was involved.
 *
 * Several of these errnos are shared with the socket layer — EHOSTDOWN and
 * ESTALE are ordinary network verdicts — so an errno alone is not enough to
 * call a failure a storage fault and put a machine on the 30-second cadence
 * with a "your disk" sentence. A real fs error names its `syscall` and usually
 * its `path`; a caller that knows the file can supply the path itself.
 */
function hasFilesystemEvidence(error: unknown, path: string | null): boolean {
  if (path) return true;
  if (!error || typeof error !== "object") return false;
  const syscall = (error as { syscall?: unknown }).syscall;
  return typeof syscall === "string" && syscall.trim().length > 0;
}

/**
 * Whether this failure is the filesystem refusing to read, rather than anything
 * a retry in two seconds could clear.
 *
 * `path` may be supplied by the caller when the error itself does not carry one
 * — an fs error names its file, a SQLite or higher-level wrapper often does not.
 */
export function classifyStorageFault(
  error: unknown,
  options: { path?: string | null } = {},
): StorageFault | null {
  const errno = readErrorCode(error);
  const path = readErrorPath(error) ?? (options.path?.trim() ? options.path : null);
  const provider = path ? detectCloudStorageProvider(path) : null;

  const faulted = (
    errno != null
    && STORAGE_FAULT_ERRNO_CODES.has(errno)
    && hasFilesystemEvidence(error, path)
  )
    // An errno the platform could not even name is a raw filesystem failure,
    // never a verdict from anything above it — on either the code or the text,
    // because Node puts it in both.
    || (errno != null && UNKNOWN_SYSTEM_ERRNO_PATTERN.test(errno))
    || UNKNOWN_SYSTEM_ERRNO_PATTERN.test(errorText(error))
    || (errno === WINDOWS_UNMAPPED_ERRNO_CODE && provider != null);
  if (!faulted) return null;

  return {
    code: "storage_read_failed",
    errno,
    path,
    provider,
    message: path
      ? storageUnreadableMessage(path, provider)
      : `ADE couldn't read this computer's data. ${storageUnreadableRemedy(provider)}`,
  };
}
