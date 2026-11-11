import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LANE_SHARE_MOVE_CHUNK_BYTES,
  LANE_SHARE_MOVE_MAX_BUNDLE_BYTES,
  LANE_SHARE_MOVE_TOO_LARGE_MESSAGE,
  laneShareMoveChunkLooksRight,
  laneShareMoveChunkSize,
  type LaneShareMoveBundleInfo,
} from "../../../shared/laneShareMove";
import type { AgentChatCrossMachineGitBundle } from "../../../shared/types/chat";

/**
 * The bytes of a lane share move (`shared/laneShareMove.ts`), on the two
 * machines that touch them. Each side keeps the bundle in its own temp
 * folder (made here, never a path from the other side), reads or writes it
 * in fixed chunks, and removes the folder when the move ends, however it
 * ends. Works the same on macOS, Linux and Windows (`os.tmpdir()`,
 * `path.join`, `rmSync` with retries for Windows handles).
 */

function makeMoveTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-move-"));
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leftover temp folder holds no user data beyond the moved bundle.
  }
}

/** The sending side: a packed bundle kept in a temp file, read back in chunks. */
export type LaneShareMoveOutgoingBundle = {
  info: Pick<LaneShareMoveBundleInfo, "bytes" | "sha256" | "chunkCount">;
  readChunk(index: number): string;
  dispose(): void;
};

/**
 * Writes a packed handoff bundle (`packHandoffGitBundle`) to a temp file and
 * returns its checksum and chunk count. Over the 50 MiB cap it refuses.
 */
export function storeLaneShareMoveBundle(bundle: AgentChatCrossMachineGitBundle): LaneShareMoveOutgoingBundle {
  const content = Buffer.from(bundle.contentBase64, "base64");
  if (content.length !== bundle.bytes) throw new Error("The packed work is damaged. Move again.");
  if (content.length > LANE_SHARE_MOVE_MAX_BUNDLE_BYTES) throw new Error(LANE_SHARE_MOVE_TOO_LARGE_MESSAGE);
  const dir = makeMoveTempDir();
  const file = path.join(dir, "move.bundle");
  try {
    fs.writeFileSync(file, content, { mode: 0o600 });
  } catch (error) {
    removeDir(dir);
    throw error;
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const bytes = content.length;
  let disposed = false;
  return {
    info: { bytes, sha256, chunkCount: Math.ceil(bytes / LANE_SHARE_MOVE_CHUNK_BYTES) },
    readChunk(index: number): string {
      if (disposed) throw new Error("This move ended.");
      const size = laneShareMoveChunkSize(bytes, index);
      if (size <= 0) throw new Error("That part of the move does not exist.");
      const buffer = Buffer.alloc(size);
      const fd = fs.openSync(file, "r");
      try {
        const read = fs.readSync(fd, buffer, 0, size, index * LANE_SHARE_MOVE_CHUNK_BYTES);
        if (read !== size) throw new Error("The packed work is damaged. Move again.");
      } finally {
        fs.closeSync(fd);
      }
      return buffer.toString("base64");
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeDir(dir);
    },
  };
}

/** The receiving side: chunks in order into a temp file, checked as they come. */
export type LaneShareMoveIncomingBundle = {
  readonly received: number;
  /** Appends chunk `index`. Refuses any index other than the next one, a wrong size, or bad base64. */
  write(index: number, data: unknown): void;
  /**
   * All chunks arrived: checks the total size and the checksum, and returns
   * the bundle as the handoff landing code reads it.
   */
  finish(meta: Pick<LaneShareMoveBundleInfo, "branchHeadSha" | "snapshotSha" | "unpushedCommitCount" | "changedFileCount">): AgentChatCrossMachineGitBundle;
  dispose(): void;
};

/**
 * A receiver for one move's bundle. `bytes` and `sha256` come from the
 * moved payload; the receiver writes at most `bytes` (never more than 50
 * MiB) and accepts the result only when its SHA-256 matches. A disk that
 * fills up fails the write; the caller disposes, which removes the folder.
 */
export function createLaneShareMoveReceiver(expected: { bytes: number; sha256: string }): LaneShareMoveIncomingBundle {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || expected.bytes > LANE_SHARE_MOVE_MAX_BUNDLE_BYTES) {
    throw new Error(LANE_SHARE_MOVE_TOO_LARGE_MESSAGE);
  }
  const dir = makeMoveTempDir();
  const file = path.join(dir, "move.bundle");
  fs.writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
  const hash = createHash("sha256");
  const chunkCount = Math.ceil(expected.bytes / LANE_SHARE_MOVE_CHUNK_BYTES);
  let next = 0;
  let written = 0;
  let disposed = false;
  let failed = false;
  return {
    get received() {
      return next;
    },
    write(index: number, data: unknown): void {
      if (disposed || failed) throw new Error("This move ended.");
      if (index !== next) {
        failed = true;
        throw new Error("A part of the move arrived out of order. Move again.");
      }
      const size = laneShareMoveChunkSize(expected.bytes, index);
      if (size <= 0 || !laneShareMoveChunkLooksRight(data, size)) {
        failed = true;
        throw new Error("A part of the move arrived damaged. Move again.");
      }
      const buffer = Buffer.from(data, "base64");
      if (buffer.length !== size || written + size > expected.bytes) {
        failed = true;
        throw new Error("A part of the move arrived damaged. Move again.");
      }
      fs.appendFileSync(file, buffer);
      hash.update(buffer);
      written += size;
      next += 1;
    },
    finish(meta): AgentChatCrossMachineGitBundle {
      if (disposed || failed) throw new Error("This move ended.");
      if (next !== chunkCount || written !== expected.bytes) throw new Error("The move did not arrive complete. Move again.");
      if (hash.digest("hex") !== expected.sha256) {
        failed = true;
        throw new Error("The moved work does not match what was sent. Move again.");
      }
      failed = true; // The hash is spent; a second finish is refused.
      const content = fs.readFileSync(file);
      if (content.length !== expected.bytes) throw new Error("The move did not arrive complete. Move again.");
      return {
        contentBase64: content.toString("base64"),
        bytes: content.length,
        branchHeadSha: meta.branchHeadSha,
        snapshotSha: meta.snapshotSha,
        unpushedCommitCount: meta.unpushedCommitCount,
        changedFileCount: meta.changedFileCount,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeDir(dir);
    },
  };
}
