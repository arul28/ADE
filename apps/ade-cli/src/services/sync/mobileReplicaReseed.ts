import {
  CRSQL_EXPORT_VERSION_GROUP_TOO_LARGE_CODE,
  type CrsqlChangeRow,
  type SyncChangesetBatchPayload,
} from "../../../../desktop/src/shared/types";
import {
  DEFAULT_MAX_CHANGESET_BATCH_ROWS,
  makeChangesetBatchId,
} from "./changesetPump";

export const SYNC_HOST_MOBILE_REPLICA_RESEED_GAP = 5_000;
export const MOBILE_REPLICA_RESEED_MAX_ROWS = 10_000;
export const MOBILE_REPLICA_RESEED_MAX_BYTES = 4 * 1024 * 1024;
export const MOBILE_REPLICA_RESEED_BUILD_ROWS_PER_POLL = DEFAULT_MAX_CHANGESET_BATCH_ROWS * 4;

export type MobileReplicaReseedCache = {
  targetDbVersion: number;
  scanFromDbVersion: number;
  changes: CrsqlChangeRow[];
  approximateBytes: number;
  buildSteps: number;
  status: "building" | "ready" | "too_large";
};

export function createMobileReplicaReseedCache(targetDbVersion: number): MobileReplicaReseedCache {
  return {
    targetDbVersion,
    scanFromDbVersion: 0,
    changes: [],
    approximateBytes: 0,
    buildSteps: 0,
    status: "building",
  };
}

export function advanceMobileReplicaReseedCache(args: {
  cache: MobileReplicaReseedCache;
  versionWindow: number;
  exportChangesSince: (
    version: number,
    options: {
      maxRows: number;
      throughDbVersion: number;
      excludeTables: readonly string[];
      rejectOversizedVersionGroup: true;
    },
  ) => CrsqlChangeRow[];
  excludeTables: readonly string[];
  includeChange: (change: CrsqlChangeRow) => boolean;
}): MobileReplicaReseedCache {
  const { cache } = args;
  if (cache.status !== "building") return cache;

  const scanThroughDbVersion = Math.min(
    cache.scanFromDbVersion + args.versionWindow,
    cache.targetDbVersion,
  );
  let exported: CrsqlChangeRow[];
  try {
    exported = args.exportChangesSince(cache.scanFromDbVersion, {
      maxRows: MOBILE_REPLICA_RESEED_BUILD_ROWS_PER_POLL,
      throughDbVersion: scanThroughDbVersion,
      excludeTables: args.excludeTables,
      rejectOversizedVersionGroup: true,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== CRSQL_EXPORT_VERSION_GROUP_TOO_LARGE_CODE) {
      throw error;
    }
    cache.status = "too_large";
    cache.changes = [];
    cache.approximateBytes = 0;
    return cache;
  }
  cache.scanFromDbVersion = exported.length > 0
    ? Number(exported[exported.length - 1].db_version)
    : scanThroughDbVersion;
  cache.buildSteps += 1;

  for (const change of exported) {
    if (!args.includeChange(change)) continue;
    const changeBytes = Buffer.byteLength(JSON.stringify(change), "utf8") + 1;
    if (
      cache.changes.length >= MOBILE_REPLICA_RESEED_MAX_ROWS
      || cache.approximateBytes + changeBytes > MOBILE_REPLICA_RESEED_MAX_BYTES
    ) {
      cache.status = "too_large";
      cache.changes = [];
      cache.approximateBytes = 0;
      return cache;
    }
    cache.changes.push(change);
    cache.approximateBytes += changeBytes;
  }

  if (cache.scanFromDbVersion >= cache.targetDbVersion) {
    cache.status = "ready";
  }
  return cache;
}

export function buildMobileReplicaReseedPayload(args: {
  cache: MobileReplicaReseedCache;
  deviceId: string;
  fromDbVersion: number;
}): SyncChangesetBatchPayload | null {
  const payload: SyncChangesetBatchPayload = {
    batchId: makeChangesetBatchId({
      deviceId: args.deviceId,
      fromDbVersion: args.fromDbVersion,
      toDbVersion: args.cache.targetDbVersion,
    }),
    reason: "catchup",
    fromDbVersion: args.fromDbVersion,
    toDbVersion: args.cache.targetDbVersion,
    changes: args.cache.changes,
  };
  return Buffer.byteLength(JSON.stringify(payload), "utf8") <= MOBILE_REPLICA_RESEED_MAX_BYTES
    ? payload
    : null;
}
