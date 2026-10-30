/** Largest uncommitted patch a chat sends with a command on another machine. Bigger changes go through git. */
export const REMOTE_WORK_MAX_PATCH_BYTES = 16 * 1024 * 1024;

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
  projectId: string | null;
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
};
