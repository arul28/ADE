/**
 * The lane a per-lane session (App Control) belongs to, or null.
 *
 * In order: the chat's lane, then an explicit lane that is live, then the lane
 * worktree the cwd sits in (the deepest one, through realpath, via
 * `laneService.getLaneIdForPath`). The primary lane is never chosen by cwd
 * alone: its worktree is the project root, which is also the default cwd, so
 * matching it would be the old "first lane" fallback by another name.
 *
 * Null means the caller must refuse. There is no fallback lane.
 */
export async function resolveSessionLaneId(args: {
  laneId?: string | null;
  chatSessionId?: string | null;
  cwd?: string | null;
  getChatLaneId: (chatSessionId: string) => Promise<string | null | undefined>;
  /** Live (non-archived) lanes only. */
  isLiveLane: (laneId: string) => boolean;
  /** The deepest live lane worktree containing the path, or null. */
  laneIdForPath: (absolutePath: string) => string | null;
  isPrimaryLane: (laneId: string) => Promise<boolean>;
}): Promise<string | null> {
  const chatId = args.chatSessionId?.trim();
  if (chatId) {
    const chatLaneId = await args.getChatLaneId(chatId).catch(() => null);
    if (chatLaneId) return chatLaneId;
  }
  const explicitLaneId = args.laneId?.trim();
  if (explicitLaneId) return args.isLiveLane(explicitLaneId) ? explicitLaneId : null;
  const cwd = args.cwd?.trim();
  if (!cwd) return null;
  const pathLaneId = args.laneIdForPath(cwd);
  if (!pathLaneId) return null;
  return (await args.isPrimaryLane(pathLaneId).catch(() => true)) ? null : pathLaneId;
}
