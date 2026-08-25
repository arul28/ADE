/**
 * Display-only path shortening, shared by main, renderer, and the CLI.
 *
 * A build root is only useful in a status line as "which checkout was this",
 * and the distinguishing segment (the lane worktree name, the repo name) lives
 * at the end — so the tail is what survives. Three copies of this used to
 * exist, each with its own segment count and separator, which is how the same
 * root printed three different ways across the launch stepper, the CLI, and the
 * drawer.
 *
 * The result is never a real path: separators are normalized to `/` and an
 * elision marker is prepended. Never feed it back to `fs` or `path`.
 */
export function abbreviatePathTail(value: string, segments = 2): string {
  if (!value) return value;
  const parts = value.split(/[/\\]/).filter(Boolean);
  if (parts.length <= segments) return value;
  return `…/${parts.slice(-segments).join("/")}`;
}
