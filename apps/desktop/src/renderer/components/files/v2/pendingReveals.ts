/**
 * One-shot "reveal this line when the file's editor next binds its model" queue.
 * Set by the search overlay before opening a content match; consumed by
 * CodeViewer when it attaches the model for that path. Avoids threading an
 * editor-API ref up through the group tree.
 */
const pending = new Map<string, number>();

export function setPendingReveal(path: string, line: number): void {
  pending.set(path, line);
}

export function takePendingReveal(path: string): number | null {
  const line = pending.get(path);
  if (line == null) return null;
  pending.delete(path);
  return line;
}
