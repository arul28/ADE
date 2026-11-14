/**
 * A work copy stands in for a lane where a service keys its state by lane,
 * as the Apple device registry does: `remote-work-<12 hex>`, the same hash as
 * the copy's folder. No real lane id has this prefix (they are UUIDs).
 */
export const REMOTE_WORK_LANE_PREFIX = "remote-work-";

export function isRemoteWorkLaneId(laneId: string | null | undefined): boolean {
  return typeof laneId === "string" && laneId.startsWith(REMOTE_WORK_LANE_PREFIX);
}

/** Largest uncommitted patch a chat sends with a command on another machine. Bigger changes go through git. */
export const REMOTE_WORK_MAX_PATCH_BYTES = 16 * 1024 * 1024;

/** The largest file `ade files push|pull --machine` moves either way. A bigger one belongs in git, or a release asset. */
export const REMOTE_WORK_FILE_MAX_BYTES = 256 * 1024 * 1024;
/**
 * One file chunk, before base64. A reply is capped at 12 MiB
 * (SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES) and a request carries a work copy's
 * 16 MiB patch already, so 4 MiB (5.4 MiB as base64) fits both ways.
 */
export const REMOTE_WORK_FILE_CHUNK_BYTES = 4 * 1024 * 1024;

/** The steps of the `work_copy_file` tool: a push is begin, chunks, commit (or abort); a pull is stat, then chunks. */
export const REMOTE_WORK_FILE_OPS = ["push_begin", "push_chunk", "push_commit", "push_abort", "pull_stat", "pull_chunk"] as const;
export type RemoteWorkFileOp = (typeof REMOTE_WORK_FILE_OPS)[number];

export function isRemoteWorkFileOp(value: unknown): value is RemoteWorkFileOp {
  return typeof value === "string" && (REMOTE_WORK_FILE_OPS as readonly string[]).includes(value);
}

/** Why a file is refused for being too big; the same words on both machines. */
export function remoteWorkFileTooLargeMessage(bytes: number, name = "The file"): string {
  return `${name} is ${bytes} bytes, over the ${REMOTE_WORK_FILE_MAX_BYTES / (1024 * 1024)} MiB limit for ade files push and pull. `
    + "Commit it (or put it where both machines can download it) instead.";
}

/**
 * `remote_work.list` answers for the whole machine: every project's copies.
 *
 * A work copy on this machine for a chat on another machine
 * (`ade shell start --machine`), as Settings › Machines lists it.
 */
export type RemoteWorkCopyListing = {
  /** Foreign owner id (`remote:<device>:<chat>`); pass it to `remote_work.delete`. */
  owner: string;
  /** The chat's id on its own machine, when the owner is a chat. */
  chatSessionId: string | null;
  /** The project here that holds the copy; pin delete to it. */
  projectId: string;
  projectRoot: string;
  /** The machine the chat runs on. */
  machineName: string | null;
  branch: string | null;
  head: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
  /** A command runs in the copy, or one is starting; delete is refused until it ends. */
  running: boolean;
  /** Bytes on disk with installed deps and build output; null when too large to count quickly. */
  sizeBytes: number | null;
  /**
   * This machine's `remote_work.delete` honours `keepUnsynced` (keeps a copy
   * holding work nobody pushed). Absent from an older ADE, which would delete
   * it anyway, so the tools pane's Clean up leaves such a machine alone.
   */
  keepsUnsynced?: boolean;
};
