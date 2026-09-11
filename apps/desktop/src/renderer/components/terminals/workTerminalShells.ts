/**
 * The shells the terminal panel is actually showing, published for the header.
 *
 * The pane's status line used to be derived from its OWN `terminal.list` read,
 * re-run whenever a session changed or a PTY exited. That is a different list
 * from the one the drawer renders and it disagreed in both directions: a shell
 * the drawer had just opened was still absent from the daemon's list ("Terminal
 * · No shells" over a live shell), and a split whose second pane had already
 * finished was filtered out of it ("1 shell" over two panes).
 *
 * So the drawer publishes what it renders. One number per owning session, a
 * plain subscription, no polling and no IPC: the panel is the only thing that
 * knows how many shells are on screen, so it is the thing that says so. When
 * the panel is not mounted — you are looking at another tool — the count is
 * absent and the pane falls back to its own read, which is the best answer
 * available then.
 */

const countsByOwner = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to every change; the count itself is read with `getWorkTerminalShellCount`. */
export function subscribeWorkTerminalShells(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * How many shells the panel owning `ownerSessionId` is showing, or `null` when
 * no panel is mounted for it.
 *
 * A primitive return, so `useSyncExternalStore` can compare snapshots without
 * a cache: returning a fresh object here would re-render on every unrelated
 * publish.
 */
export function getWorkTerminalShellCount(ownerSessionId: string | null): number | null {
  if (!ownerSessionId) return null;
  return countsByOwner.get(ownerSessionId) ?? null;
}

export function publishWorkTerminalShellCount(ownerSessionId: string, count: number): void {
  if (countsByOwner.get(ownerSessionId) === count) return;
  countsByOwner.set(ownerSessionId, count);
  emit();
}

export function clearWorkTerminalShellCount(ownerSessionId: string): void {
  if (!countsByOwner.delete(ownerSessionId)) return;
  emit();
}

/** Tests only: drop every published count so suites cannot leak into each other. */
export function resetWorkTerminalShellCounts(): void {
  if (countsByOwner.size === 0) return;
  countsByOwner.clear();
  emit();
}
