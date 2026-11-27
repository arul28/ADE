import { BRAND } from "./brand";
/**
 * Whether a project folder sits in a place the operating system clears on its
 * own: macOS's per-user temp (`/var/folders/…`), `/tmp` and `/var/tmp` on macOS
 * and Linux, and `%TEMP%` on Windows (`…\AppData\Local\Temp`, `C:\Windows\Temp`).
 *
 * Pure and by spelling only, so it judges a path from any OS: a brain on
 * Windows answers with `C:\…` paths, which a Mac's CLI checks the same way.
 * Registering there is allowed; callers only warn.
 */

const POSIX_TEMP_ROOTS = [
  /^\/(?:private\/)?tmp(?:\/|$)/,
  /^\/(?:private\/)?var\/tmp(?:\/|$)/,
  /^\/(?:private\/)?var\/folders\//,
];

const WINDOWS_TEMP_ROOTS = [
  /^[a-z]:\\users\\[^\\]+\\appdata\\local\\temp(?:\\|$)/i,
  /^[a-z]:\\windows\\temp(?:\\|$)/i,
];

/** True when `rootPath` is inside a temporary folder the OS may empty. */
export function isTemporaryFolderPath(rootPath: string | null | undefined): boolean {
  const raw = rootPath?.trim() ?? "";
  if (!raw) return false;
  if (/^[a-z]:[\\/]/i.test(raw)) {
    const windows = raw.replace(/\//g, "\\");
    return WINDOWS_TEMP_ROOTS.some((pattern) => pattern.test(windows));
  }
  return POSIX_TEMP_ROOTS.some((pattern) => pattern.test(raw));
}

/** The warning a person reads after adding a project at `rootPath`, or null when it is not in a temporary folder. */
export function temporaryFolderWarning(rootPath: string | null | undefined): string | null {
  if (!isTemporaryFolderPath(rootPath)) return null;
  return `This project's folder (${rootPath!.trim()}) is in a temporary folder, which the system can empty without asking. `
    + `Move it somewhere permanent (Settings › Location › Move… in ${BRAND.NAME}) so its lanes and chats are not lost.`;
}
