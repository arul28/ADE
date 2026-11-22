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
  /**
   * An agent CLI terminal (kind "shell"): the CLI's name, "Claude Code",
   * "Codex", …, which every surface shows instead of "Shell". Absent for a
   * plain shell and on older hosts.
   */
  toolLabel?: string | null;
  /** Shell: the chat it was attached to, if any. */
  parentChatId?: string | null;
  /** Lane: the worktree folder is still on disk. */
  worktreePresent?: boolean;
  /** Lane: the git branch, which a delete from the archive keeps. */
  branchRef?: string | null;
  /**
   * Lane: its folder is still on disk and was archived longer ago than the
   * "Free up space after" setting. Computed from `archivedAt`, never stored.
   */
  freeUpDue?: boolean;
  /** Lane: why the last removal of its folder did not finish, when it did not. */
  freeUpError?: string | null;
};

export type ArchiveListArgs = {
  kinds?: ArchiveItemKind[];
  /** Only items archived at least this many days ago. */
  olderThanDays?: number;
};

export type ArchiveListResult = {
  items: ArchivedItem[];
  /**
   * Items archived at least this many days ago count as old: the "Free up
   * space after" setting, or 14 when it is off. Absent on older hosts.
   */
  staleAfterDays?: number;
};

export type ArchiveSummaryArgs = {
  /** Items archived at least this many days ago count as stale. Default: the list's `staleAfterDays`. */
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

/** The stale line on a host that does not say (`ArchiveListResult.staleAfterDays`). */
export const DEFAULT_ARCHIVE_STALE_DAYS = 14;
