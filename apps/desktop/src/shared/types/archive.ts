/**
 * The archive: lanes, chats, and shells that were archived (hidden, not
 * deleted). One list across the three kinds, so Settings → Archive, the weekly
 * cleanup reminder, `ade archive`, and iOS all read the same thing.
 *
 * Nothing here deletes on its own. Delete is always an explicit request.
 */

export type ArchiveItemKind = "lane" | "chat" | "shell";

export const ARCHIVE_ITEM_KINDS: readonly ArchiveItemKind[] = ["lane", "chat", "shell"];

export type ArchivedItem = {
  kind: ArchiveItemKind;
  /** Lane id for a lane; terminal session id for a chat or shell. */
  id: string;
  title: string;
  /** The owning lane; for a lane, the lane itself. */
  laneId: string | null;
  laneName: string | null;
  /** The owning lane's colour, so every surface can paint the item like its lane. */
  laneColor?: string | null;
  archivedAt: string;
  /**
   * Bytes the item still holds on disk, when known: a lane's worktree folder,
   * a chat's or shell's transcript. Null when not measured.
   */
  sizeBytes: number | null;
  /** Chat or shell: the session's tool type (e.g. "claude-chat", "shell"). */
  toolType?: string | null;
  /** Shell: the chat it was attached to, if any. */
  parentChatId?: string | null;
  /** Lane: the worktree folder is still on disk. */
  worktreePresent?: boolean;
  /** Lane: the git branch, which a delete from the archive keeps. */
  branchRef?: string | null;
};

export type ArchiveListArgs = {
  kinds?: ArchiveItemKind[];
  /** Only items archived at least this many days ago. */
  olderThanDays?: number;
};

export type ArchiveListResult = {
  items: ArchivedItem[];
};

export type ArchiveSummaryArgs = {
  /** Items archived at least this many days ago count as stale. Default 14. */
  olderThanDays?: number;
};

export type ArchiveSummary = {
  total: number;
  byKind: Record<ArchiveItemKind, number>;
  olderThanDays: number;
  staleTotal: number;
  staleByKind: Record<ArchiveItemKind, number>;
  /** Sum of measured `sizeBytes` over stale items; null when none were measured. */
  staleBytes: number | null;
  oldestArchivedAt: string | null;
};

export type ArchiveItemRef = {
  kind: ArchiveItemKind;
  id: string;
};

export type ArchiveActionArgs = {
  items: ArchiveItemRef[];
  /**
   * Delete only: remove a lane worktree that still has uncommitted changes.
   * Without it such a lane lands in `failed`. Ignored by restore.
   */
  force?: boolean;
};

export type ArchiveActionResult = {
  done: ArchiveItemRef[];
  failed: Array<ArchiveItemRef & { error: string }>;
};

export const DEFAULT_ARCHIVE_STALE_DAYS = 14;
