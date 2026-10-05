import type { AppControlFrameDemand } from "../../desktop/src/shared/appControlFrameDemand";

/** The part of a project's App Control service a connection's demand writes to. */
export type FrameDemandTarget = {
  setFrameDemand: (sourceId: string, demand: AppControlFrameDemand | null) => void;
};

let nextConnectionId = 1;

/**
 * One RPC connection's say in which lanes' screencasts stream.
 *
 * A client that subscribes to frames without ever declaring which lanes it
 * shows predates demand, and keeps every lane streaming for as long as that
 * subscription lives. Its first declaration replaces that.
 *
 * A declaration is kept as data per project, not as a write to one service: a
 * project's scope can restart under an open connection, and the new scope's
 * service gets the connection's demand when the connection next subscribes to
 * it. Declarations land in call order even when their scope lookups finish out
 * of order, because each lookup applies the newest declaration, not its own.
 */
export function createConnectionFrameDemand() {
  const sourceId = `rpc-connection-${nextConnectionId++}`;
  let declared = false;
  const legacyReleases = new Map<string, () => void>();
  /** projectId → the newest demand this connection declared there. */
  const desired = new Map<string, AppControlFrameDemand>();
  /** projectId → the service that demand was last written to. */
  const applied = new Map<string, FrameDemandTarget>();

  const releaseLegacy = (): void => {
    for (const release of legacyReleases.values()) {
      try {
        release();
      } catch {}
    }
    legacyReleases.clear();
  };

  return {
    /**
     * Every lane, for a frame subscription from a client that has not declared.
     * Returns the release to run when that subscription ends.
     */
    holdForLegacySubscription(subscriptionId: string, target: FrameDemandTarget): () => void {
      if (declared) return () => {};
      const legacySource = `${sourceId}:${subscriptionId}`;
      target.setFrameDemand(legacySource, "all");
      const release = () => {
        if (legacyReleases.get(legacySource) !== release) return;
        legacyReleases.delete(legacySource);
        target.setFrameDemand(legacySource, null);
      };
      legacyReleases.set(legacySource, release);
      return release;
    },
    /** Records this connection's demand in one project. `apply` writes it. */
    declare(projectId: string, demand: AppControlFrameDemand): void {
      declared = true;
      releaseLegacy();
      desired.set(projectId, demand);
    },
    /**
     * Writes the newest declared demand for the project to its current service.
     * A project without App Control (`target` null), or one this connection
     * never declared for, gets nothing.
     */
    apply(projectId: string, target: FrameDemandTarget | null): void {
      const demand = desired.get(projectId);
      if (!target || demand === undefined) return;
      target.setFrameDemand(sourceId, demand);
      applied.set(projectId, target);
    },
    /** The project's scope is gone, and its service with it: nothing to release. */
    forgetProject(projectId: string): void {
      applied.delete(projectId);
    },
    dispose(): void {
      releaseLegacy();
      for (const target of applied.values()) {
        try {
          target.setFrameDemand(sourceId, null);
        } catch {}
      }
      applied.clear();
      desired.clear();
    },
  };
}
