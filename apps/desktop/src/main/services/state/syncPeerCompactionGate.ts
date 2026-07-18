export type RegisteredSyncPeerCounter = {
  getRegisteredPeerCount(): number | null;
};

export function createRegisteredSyncPeerGate(args: {
  syncEnabled: boolean;
  getSyncService: () => RegisteredSyncPeerCounter | null;
}): () => boolean {
  return () => {
    if (!args.syncEnabled) return false;

    try {
      const syncService = args.getSyncService();
      return syncService == null || syncService.getRegisteredPeerCount() !== 0;
    } catch {
      // Missing or unreadable durable pairing state is not evidence that
      // compaction is safe. Keep CRR history until the registry is readable.
      return true;
    }
  };
}
