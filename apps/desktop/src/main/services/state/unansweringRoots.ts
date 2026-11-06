import path from "node:path";

/**
 * Folders that are not answering right now, and the error a file call under
 * one gets instead of waiting.
 *
 * macOS holds an `open()` in the kernel while it asks, on that computer's
 * screen, whether ADE may use a drive or folder; a hung network drive does the
 * same anywhere. The brain's project-root monitor finds such a folder off the
 * main thread and lists it here. Everything that would open a file under it
 * synchronously on the main thread checks first and fails fast: the brain's
 * `fs` wrapper (`syncFsCallTracker`) and the native SQLite openers, which no
 * `fs` wrapper sees. Empty in every process but a brain with a waiting folder.
 */

let roots: string[] = [];

/** macOS and Windows match paths without case, and Windows either separator. */
function comparablePath(value: string): string {
  if (process.platform === "win32") return value.replace(/\\/g, "/").toLowerCase();
  return process.platform === "darwin" ? value.toLowerCase() : value;
}

/** Replaces the list; empty clears it. */
export function setUnansweringRoots(next: readonly string[]): void {
  roots = next.map((root) => root.replace(/[\\/]+$/, ""));
}

/** The listed folder that contains `target`, or null. Cheap when the list is empty. */
export function unansweringRootOf(target: string): string | null {
  if (roots.length === 0) return null;
  // A relative path is relative to this process's folder, which may itself be
  // inside a marked root; only resolved while a root is marked.
  const candidate = comparablePath(path.isAbsolute(target) ? target : path.resolve(target));
  for (const root of roots) {
    const comparableRoot = comparablePath(root);
    if (candidate === comparableRoot) return root;
    if (candidate.startsWith(comparableRoot)) {
      const next = candidate.charAt(comparableRoot.length);
      if (next === "/" || next === "\\") return root;
    }
  }
  return null;
}

/**
 * The fast failure that stands in for a wait. Coded `storage_read_failed`,
 * ADE's "unreadable, not corrupt" verdict, so callers and devices show the
 * reason; deliberately no errno or syscall, which would read as an internal
 * fault and be hidden behind a reference.
 */
export class StorageNotAnsweringError extends Error {
  readonly code = "storage_read_failed";
  /** The machine's drive, not a defect in ADE: never a Sentry issue (`shared/expectedError.ts`). */
  readonly adeExpected = "environment" as const;
  readonly path: string;
  constructor(target: string, root: string) {
    super(`ADE can't read ${root} on this computer right now: it is not answering. ${notAnsweringHint()}`);
    this.path = target;
  }
}

/** What to check, in the words of the platform the folder is on. */
function notAnsweringHint(): string {
  if (process.platform === "darwin") {
    return "If macOS is asking on this computer's screen whether ADE may use this drive or folder, allow it; if the drive is not responding, reconnect it.";
  }
  if (process.platform === "win32") {
    return "If it is on a network, USB or cloud drive, open it in File Explorer to check that it is connected and signed in; if the drive is not responding, reconnect it.";
  }
  return "If it is on a network or removable drive, check that it is still mounted; if the drive is not responding, reconnect it.";
}

/** Throws {@link StorageNotAnsweringError} when `target` is under a listed folder. */
export function assertStorageAnswering(target: string): void {
  const root = unansweringRootOf(target);
  if (root !== null) throw new StorageNotAnsweringError(target, root);
}
