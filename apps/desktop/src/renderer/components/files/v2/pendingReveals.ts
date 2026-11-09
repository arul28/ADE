import { createKeyedPendingStore } from "../../../lib/pendingRequestChannel";

/**
 * One-shot "reveal this line when the file's editor next binds its model" queue.
 * Set by the search overlay before opening a content match; consumed by
 * CodeViewer when it attaches the model for that path. Keyed by path via
 * `createKeyedPendingStore`, so no editor-API ref has to thread up through the
 * group tree.
 */
export type PendingFileReveal = {
  line: number;
  column?: number;
};

const reveals = createKeyedPendingStore<PendingFileReveal>();

const revealListeners = new Set<(path: string, workspaceId: string | null) => void>();

export function setPendingReveal(path: string, reveal: PendingFileReveal, workspaceId: string | null = null): void {
  reveals.set(path, reveal);
  for (const listener of revealListeners) listener(path, workspaceId);
}

/**
 * For an editor already showing the file, where no model bind will come.
 * `workspaceId` is where the file is being opened: two lanes share relative
 * paths, and the lane being left must not take the other lane's reveal.
 */
export function subscribePendingReveals(listener: (path: string, workspaceId: string | null) => void): () => void {
  revealListeners.add(listener);
  return () => revealListeners.delete(listener);
}

export const takePendingReveal = reveals.take;
