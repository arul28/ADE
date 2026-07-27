/**
 * One-shot "reveal this line when the file's editor next binds its model" queue.
 * Set by the search overlay before opening a content match; consumed by
 * CodeViewer when it attaches the model for that path. Avoids threading an
 * editor-API ref up through the group tree.
 */
export type PendingFileReveal = {
  line: number;
  column?: number;
};

const pending = new Map<string, PendingFileReveal>();

export function setPendingReveal(path: string, reveal: PendingFileReveal): void {
  pending.set(path, reveal);
}

export function takePendingReveal(path: string): PendingFileReveal | null {
  const reveal = pending.get(path);
  if (reveal == null) return null;
  pending.delete(path);
  return reveal;
}
