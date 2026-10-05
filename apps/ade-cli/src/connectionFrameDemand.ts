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
 * subscription lives. Its first declaration replaces that, per project, until
 * the connection closes.
 */
export function createConnectionFrameDemand() {
  const sourceId = `rpc-connection-${nextConnectionId++}`;
  let declared = false;
  const legacyReleases = new Map<string, () => void>();
  const declaredReleases = new Map<string, () => void>();

  const releaseAll = (releases: Map<string, () => void>): void => {
    for (const release of releases.values()) {
      try {
        release();
      } catch {}
    }
    releases.clear();
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
    /**
     * This connection's demand in one project, replacing any it held there. A
     * project without App Control (`target` null) still ends the legacy holds.
     */
    declare(projectId: string, target: FrameDemandTarget | null, demand: AppControlFrameDemand): void {
      declared = true;
      releaseAll(legacyReleases);
      if (!target) return;
      target.setFrameDemand(sourceId, demand);
      declaredReleases.set(projectId, () => target.setFrameDemand(sourceId, null));
    },
    /** The project's scope is gone, and its service with it: nothing to release. */
    forgetProject(projectId: string): void {
      declaredReleases.delete(projectId);
    },
    dispose(): void {
      releaseAll(legacyReleases);
      releaseAll(declaredReleases);
    },
  };
}
