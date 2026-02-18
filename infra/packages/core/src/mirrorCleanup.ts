export type MirrorBlobObject = {
  key: string;
  size: number;
  lastModified: string | null;
};

export type MirrorCleanupPlan = {
  reachableBlobCount: number;
  orphanCandidates: MirrorBlobObject[];
  deletionBatch: MirrorBlobObject[];
  reclaimedBytes: number;
  warnings: string[];
};

export function planMirrorCleanup(args: {
  projectId: string;
  reachableDigests: Set<string> | string[];
  blobObjects: MirrorBlobObject[];
  nowMs: number;
  staleGraceMs: number;
  maxDelete: number;
  maxBytesScanned: number;
}): MirrorCleanupPlan {
  const reachable =
    args.reachableDigests instanceof Set
      ? args.reachableDigests
      : new Set(args.reachableDigests.map((value) => String(value).trim().toLowerCase()));
  const warnings: string[] = [];
  const orphanCandidates: MirrorBlobObject[] = [];
  let reachableBlobCount = 0;
  let scannedBytes = 0;

  for (const object of args.blobObjects) {
    scannedBytes += Math.max(0, Number(object.size) || 0);
    if (scannedBytes > args.maxBytesScanned) {
      warnings.push("max_bytes_scanned_reached");
      break;
    }

    const key = String(object.key ?? "");
    const digest = key.slice(args.projectId.length + 1).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) continue;

    if (reachable.has(digest)) {
      reachableBlobCount += 1;
      continue;
    }

    const lastModifiedTs = object.lastModified ? Date.parse(object.lastModified) : NaN;
    const ageMs = Number.isFinite(lastModifiedTs) ? Math.max(0, args.nowMs - lastModifiedTs) : Number.MAX_SAFE_INTEGER;
    if (ageMs < args.staleGraceMs) continue;
    orphanCandidates.push(object);
  }

  orphanCandidates.sort((a, b) => {
    const aTs = a.lastModified ? Date.parse(a.lastModified) : 0;
    const bTs = b.lastModified ? Date.parse(b.lastModified) : 0;
    return aTs - bTs;
  });

  const deletionBatch = orphanCandidates.slice(0, Math.max(0, args.maxDelete));
  if (orphanCandidates.length > args.maxDelete) warnings.push("max_delete_cap_reached");

  return {
    reachableBlobCount,
    orphanCandidates,
    deletionBatch,
    reclaimedBytes: deletionBatch.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0),
    warnings
  };
}
