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

export const setPendingReveal = reveals.set;

export const takePendingReveal = reveals.take;
