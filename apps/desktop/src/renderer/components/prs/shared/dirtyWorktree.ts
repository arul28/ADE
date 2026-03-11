const DIRTY_WORKTREE_PREFIX = "DIRTY_WORKTREE:";

export function isDirtyWorktreeErrorMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.includes(DIRTY_WORKTREE_PREFIX);
}

export function stripDirtyWorktreePrefix(message: string): string {
  return message.replace(DIRTY_WORKTREE_PREFIX, "").trim();
}
