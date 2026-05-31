import { randomBytes } from "node:crypto";
import type {
  CrsqlChangeRow,
  SyncChangesetBatchPayload,
} from "../../../../desktop/src/shared/types";

export const DEFAULT_MAX_CHANGESET_BATCH_BYTES = 256 * 1024;
export const DEFAULT_MAX_CHANGESET_BATCH_ROWS = 250;

export type SelectedChangesetBatchChunk = {
  changes: CrsqlChangeRow[];
  toDbVersion: number;
};

export function selectChangesetBatchChunk(args: {
  changes: CrsqlChangeRow[];
  fromDbVersion: number;
  toDbVersion: number;
  maxRows: number;
  maxBytes: number;
}): SelectedChangesetBatchChunk | null {
  let chunk: CrsqlChangeRow[] = [];
  let chunkBytes = 0;
  let lastIncludedDbVersion: number | null = null;

  for (const change of args.changes) {
    const changeDbVersion = Number(change.db_version ?? args.fromDbVersion);
    const changeBytes = Buffer.byteLength(JSON.stringify(change), "utf8");
    // The watermark is db_version-only, so rows sharing a db_version must ack together.
    if (
      chunk.length > 0
      && changeDbVersion !== lastIncludedDbVersion
      && (chunk.length >= args.maxRows || chunkBytes + changeBytes > args.maxBytes)
    ) {
      break;
    }
    chunk.push(change);
    chunkBytes += changeBytes;
    lastIncludedDbVersion = changeDbVersion;
  }

  if (chunk.length === 0 && args.changes.length > 0) {
    chunk = [args.changes[0]!];
    lastIncludedDbVersion = Number(chunk[0]!.db_version ?? args.fromDbVersion);
  }
  if (chunk.length === 0 && args.toDbVersion <= args.fromDbVersion) return null;

  const chunkToDbVersion = lastIncludedDbVersion ?? args.toDbVersion;
  return { changes: chunk, toDbVersion: chunkToDbVersion };
}

export function makeChangesetBatchId(args: {
  deviceId: string;
  fromDbVersion: number;
  toDbVersion: number;
  nowMs?: number;
  entropyHex?: string;
}): string {
  const nowMs = args.nowMs ?? Date.now();
  const entropyHex = args.entropyHex ?? randomBytes(4).toString("hex");
  return `changeset:${args.deviceId}:${args.fromDbVersion}:${args.toDbVersion}:${nowMs}:${entropyHex}`;
}

export function buildChangesetBatchPayload(args: {
  deviceId: string;
  reason: SyncChangesetBatchPayload["reason"];
  fromDbVersion: number;
  toDbVersion: number;
  changes: CrsqlChangeRow[];
  maxRows?: number;
  maxBytes?: number;
  nowMs?: number;
  entropyHex?: string;
}): SyncChangesetBatchPayload | null {
  const selected = selectChangesetBatchChunk({
    changes: args.changes,
    fromDbVersion: args.fromDbVersion,
    toDbVersion: args.toDbVersion,
    maxRows: args.maxRows ?? DEFAULT_MAX_CHANGESET_BATCH_ROWS,
    maxBytes: args.maxBytes ?? DEFAULT_MAX_CHANGESET_BATCH_BYTES,
  });
  if (!selected) return null;

  const batchId = makeChangesetBatchId({
    deviceId: args.deviceId,
    fromDbVersion: args.fromDbVersion,
    toDbVersion: selected.toDbVersion,
    nowMs: args.nowMs,
    entropyHex: args.entropyHex,
  });
  return {
    batchId,
    reason: args.reason,
    fromDbVersion: args.fromDbVersion,
    toDbVersion: selected.toDbVersion,
    changes: selected.changes,
  };
}
