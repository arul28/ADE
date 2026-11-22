import type { TerminalRuntimeSnapshot } from "./TerminalView";

/*
 * Read access to the live terminals for code that must not load xterm.
 *
 * `TerminalView` owns the terminal runtimes and registers its reader here when
 * its module loads. Before that no terminal runtime exists, so the answer is
 * null, which is what `getTerminalRuntimeSnapshot` returns for a session with
 * no runtime.
 */

type SnapshotReader = (sessionId: string) => TerminalRuntimeSnapshot | null;

let reader: SnapshotReader | null = null;

/** Called once by `TerminalView` when its module loads. */
export function registerTerminalRuntimeSnapshotReader(next: SnapshotReader): void {
  reader = next;
}

/** The live terminal of `sessionId`, or null when it has none. */
export function readTerminalRuntimeSnapshot(sessionId: string): TerminalRuntimeSnapshot | null {
  return reader ? reader(sessionId) : null;
}
