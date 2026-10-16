/**
 * The roving index for a vertical rail's arrow/Home/End keys.
 *
 * The composer's model picker rail and the Custom provider editor's source rail
 * are the two vertical rails in the app, and both move selection the same way;
 * one helper keeps the two from drifting apart.
 */
export function railNavIndex(key: string, index: number, count: number): number {
  const last = Math.max(0, count - 1);
  if (key === "Home") return 0;
  if (key === "End") return last;
  return Math.min(Math.max(0, index + (key === "ArrowDown" ? 1 : -1)), last);
}
