/**
 * The archive's side of the account copy (`ctoAccountCopyService.ts`): the
 * home writes its archive to the account after the copy, and a new home takes
 * the old home's archive in after the notes. The encoding is
 * `ctoArchiveCopy.ts`.
 *
 * Rules:
 * - A home never writes over another machine's index before it has taken
 *   that archive in. Chunks that can't be read any more (removed, or from a
 *   newer build) are skipped: their rows stay in the old home's archive.
 * - An index this build can't read is left alone.
 * - A save removes only chunks of this machine's own previous index. Chunks of
 *   an index it took over stay: the old home may still point at them before
 *   it hears of the move.
 * - A save skips a chunk the account holds only when its own previous index
 *   names it. Any other chunk it writes again: the new revision makes the
 *   relay refuse a late delete from the old home, which "queued" alone can't
 *   prove lost its index write.
 */

import type { CtoHomeMachineRecord } from "../../../shared/ctoHomeMachine";
import { CTO_ACCOUNT_COPY_VAULT_KIND } from "../../../shared/ctoAccountCopy";
import { ACCOUNT_VAULT_NO_REVISION } from "../../../shared/types/accountVault";
import {
  CTO_ARCHIVE_COPY_FLOOR_META,
  CTO_ARCHIVE_COPY_INDEX_KEY,
  decodeCtoArchiveCopyChunk,
  decodeCtoArchiveCopyIndex,
  encodeCtoArchiveCopyIndex,
  packCtoArchiveCopy,
  readCtoArchiveCopyFloors,
  type CtoArchiveCopyIndex,
} from "./ctoArchiveCopy";
import type { CtoAccountCopyVault } from "./ctoAccountCopyService";
import type { CtoArchiveRecord } from "./ctoMemoryArchive";
import type { CtoMemoryService } from "./ctoMemoryService";

type Logger = {
  info?: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

type VaultRow = ReturnType<CtoAccountCopyVault["list"]>[number];

/** How long a chunk a fresh index names may be missing before it counts as lost. */
const CHUNK_SETTLE_MS = 10 * 60_000;

type CtoArchiveCopyMemory = Partial<Pick<
  CtoMemoryService,
  "archiveStamp" | "exportArchiveForCopy" | "importArchiveFromCopy" | "readArchiveMeta" | "writeArchiveMeta"
>>;

export function createCtoArchiveCopySync(args: {
  vault: CtoAccountCopyVault | null;
  repoScope: () => string | null;
  memory: CtoArchiveCopyMemory;
  sameDevice: (left: string | null | undefined, right: string | null | undefined) => boolean;
  logger: Logger;
  now: () => number;
}) {
  const { logger } = args;
  /** The archive stamp last written to the account from here; null: write on the next save. */
  let lastStamp: string | null = null;
  /** The other machine's index this one took in (`owner|savedAt`). */
  let takenFrom: string | null = null;

  const indexIdentity = (index: CtoArchiveCopyIndex): string => `${index.ownerDeviceId}|${index.savedAt}`;

  /** The archive index in the account: absent, readable, or there but not readable here. */
  const readIndex = (scope: string, rows: readonly VaultRow[]): { row: VaultRow | null; index: CtoArchiveCopyIndex | null; unreadable: boolean } => {
    const row = rows.find((item) => item.kind === CTO_ACCOUNT_COPY_VAULT_KIND && item.key === CTO_ARCHIVE_COPY_INDEX_KEY) ?? null;
    if (!row || row.deleted || !args.vault) return { row, index: null, unreadable: false };
    const index = decodeCtoArchiveCopyIndex(args.vault.get(scope, CTO_ACCOUNT_COPY_VAULT_KIND, CTO_ARCHIVE_COPY_INDEX_KEY));
    // A value the relay couldn't open, or an index from a newer build, is
    // still someone's archive: never written over as if there were none.
    return { row, index, unreadable: index == null };
  };

  /**
   * Takes another home's archive into this machine's. True when what could
   * be read is stored; a chunk that is gone is skipped (logged), so one lost
   * chunk can't stop the archive travelling. The heat comes only with every
   * chunk. False when the archive here couldn't store it, or a chunk of a
   * fresh index hasn't arrived yet: the next save tries again.
   */
  const take = (scope: string, index: CtoArchiveCopyIndex): boolean => {
    const importer = args.memory.importArchiveFromCopy;
    if (!args.vault || !importer) return false;
    const records: CtoArchiveRecord[] = [];
    let missing = 0;
    for (const key of index.chunks) {
      const rows = decodeCtoArchiveCopyChunk(args.vault.get(scope, CTO_ACCOUNT_COPY_VAULT_KIND, key));
      if (rows) records.push(...rows);
      else missing += 1;
    }
    const stored = importer(records, missing ? [] : index.heat);
    const meta = { rows: records.length, chunks: index.chunks.length, missing, stored };
    if (!stored) {
      logger.warn("cto.archive_copy_take_failed", meta);
      return false;
    }
    // A chunk of a fresh index may still be on its way (the relay can hand
    // out the index first): until it settles, the old index stays, and the
    // next save reads its chunks again. After that the chunk counts as lost.
    const savedAt = Date.parse(index.savedAt);
    if (missing && Number.isFinite(savedAt) && args.now() - savedAt < CHUNK_SETTLE_MS) {
      logger.info?.("cto.archive_copy_waiting_for_chunks", meta);
      return false;
    }
    takenFrom = indexIdentity(index);
    if (missing) logger.warn("cto.archive_copy_incomplete", meta);
    else logger.info?.("cto.archive_copy_taken", meta);
    return true;
  };

  /** After a restore: the old home's archive, when the account holds one. Not required for the move. */
  const takeAfterRestore = (self: string | null): void => {
    const scope = args.repoScope();
    if (!scope || !args.vault) return;
    try {
      const { index } = readIndex(scope, args.vault.list(scope));
      if (index && !args.sameDevice(index.ownerDeviceId, self)) take(scope, index);
    } catch (error) {
      logger.warn("cto.archive_copy_take_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * Writes the chunks this machine's own index doesn't already hold; how many,
   * or null when one couldn't be queued. `ownChunks`: the chunks of this
   * machine's own index in the account now (empty after a takeover).
   */
  const writeChunks = (
    scope: string,
    chunks: ReadonlyArray<{ key: string; value: string }>,
    byKey: ReadonlyMap<string, VaultRow>,
    ownChunks: ReadonlySet<string>,
    reason: string,
  ): number | null => {
    let written = 0;
    for (const chunk of chunks) {
      const existing = byKey.get(chunk.key);
      // Named by content: a live row this machine wrote holds these rows.
      if (existing && !existing.deleted && ownChunks.has(chunk.key)) continue;
      const answer = args.vault!.trySet(scope, CTO_ACCOUNT_COPY_VAULT_KIND, chunk.key, chunk.value, {
        expectedRevision: existing?.revision ?? ACCOUNT_VAULT_NO_REVISION,
      });
      if (answer !== "queued") {
        logger.warn("cto.archive_copy_not_saved", { reason, answer, part: "chunk" });
        return null;
      }
      written += 1;
    }
    return written;
  };

  /** Tombstones for chunks of this machine's previous index that the new one dropped. */
  const removeDroppedChunks = (scope: string, previous: CtoArchiveCopyIndex, next: CtoArchiveCopyIndex, byKey: ReadonlyMap<string, VaultRow>): number => {
    const keep = new Set(next.chunks);
    let removed = 0;
    for (const key of previous.chunks) {
      const row = byKey.get(key);
      if (!row || row.deleted || keep.has(key)) continue;
      if (args.vault!.tryRemove?.(scope, CTO_ACCOUNT_COPY_VAULT_KIND, key, { expectedRevision: row.revision }) === "queued") removed += 1;
    }
    return removed;
  };

  /**
   * Writes this machine's archive to the account when it changed: the chunks
   * it lacks, then the index, then tombstones for its own dropped chunks.
   * Called only after the copy was written (or was already current) by the home.
   */
  const save = (scope: string, self: string, home: CtoHomeMachineRecord | null, reason: string): void => {
    const { vault, memory } = args;
    if (!vault || !memory.archiveStamp || !memory.exportArchiveForCopy) return;
    try {
      const stamp = memory.archiveStamp();
      if (stamp == null) return;
      const rows = vault.list(scope);
      const current = readIndex(scope, rows);
      if (current.unreadable) {
        logger.warn("cto.archive_copy_index_unreadable", { reason });
        return;
      }
      const ownIndex = current.index != null && args.sameDevice(current.index.ownerDeviceId, self);
      if (stamp === lastStamp && ownIndex) return;
      if (current.index && !ownIndex) {
        // Same rule as the copy: with no home named, never over another machine's.
        if (!home?.deviceId) return;
        if (takenFrom !== indexIdentity(current.index) && !take(scope, current.index)) return;
      }
      const exported = memory.exportArchiveForCopy();
      if (!exported) return;
      const floors = readCtoArchiveCopyFloors(memory.readArchiveMeta?.(CTO_ARCHIVE_COPY_FLOOR_META) ?? null);
      const pack = packCtoArchiveCopy(exported.rows, floors);
      if (pack.floors.entries !== floors.entries || pack.floors.story !== floors.story) {
        memory.writeArchiveMeta?.(CTO_ARCHIVE_COPY_FLOOR_META, JSON.stringify(pack.floors));
        logger.info?.("cto.archive_copy_trimmed", { leftOut: pack.leftOut, floors: pack.floors });
      }
      const byKey = new Map(rows.filter((row) => row.kind === CTO_ACCOUNT_COPY_VAULT_KIND).map((row) => [row.key, row]));
      const ownPrevious = ownIndex ? current.index : null;
      const written = writeChunks(scope, pack.chunks, byKey, new Set(ownPrevious?.chunks ?? []), reason);
      if (written == null) return;
      const index: CtoArchiveCopyIndex = {
        v: 1,
        ownerDeviceId: self,
        savedAt: new Date(args.now()).toISOString(),
        chunks: pack.chunks.map((chunk) => chunk.key),
        rows: pack.chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
        heat: exported.heat,
      };
      const answer = vault.trySet(scope, CTO_ACCOUNT_COPY_VAULT_KIND, CTO_ARCHIVE_COPY_INDEX_KEY, encodeCtoArchiveCopyIndex(index), {
        expectedRevision: current.row?.revision ?? ACCOUNT_VAULT_NO_REVISION,
      });
      if (answer !== "queued") {
        logger.warn("cto.archive_copy_not_saved", { reason, answer, part: "index" });
        return;
      }
      lastStamp = stamp;
      takenFrom = null;
      // Only after the new index is queued: until then the old one points at them.
      const removed = ownPrevious ? removeDroppedChunks(scope, ownPrevious, index, byKey) : 0;
      logger.info?.("cto.archive_copy_saved", { reason, rows: index.rows, chunks: index.chunks.length, written, removed });
    } catch (error) {
      logger.warn("cto.archive_copy_save_failed", { reason, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return { save, takeAfterRestore };
}
