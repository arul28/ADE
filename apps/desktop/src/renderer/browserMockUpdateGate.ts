/**
 * Browser preview of the update gate (`/client/minimum`). Fake data only.
 *
 * `?mockUpdateGate=<scenario>`:
 *  - `self`: this computer (1.2.126) is below the Stable minimum (1.2.127):
 *    the full-window "Update ADE to keep working" screen. Update now runs a
 *    pretend check and download, then a restart that fails, so the error and
 *    Retry show. `&mockUpdateGateBrew=1` adds the Homebrew command.
 *  - `self-download`: the same, on a copy that cannot install updates itself
 *    (a Linux package): only the download page.
 *  - `remote`: this computer is current; Studio Mac (connected) runs 1.2.120.
 *    Its lanes and chats show the "runs an old version" panel.
 * Without the flag nothing here runs.
 */

type AnyApi = Record<string, any>;

function scenario(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("mockUpdateGate");
  } catch {
    return null;
  }
}

function flag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).has(name);
  } catch {
    return false;
  }
}

const MINIMUM = { desktop: { stable: "1.2.127", beta: "1.2.128-beta.2" } };
const LATEST = { stable: "1.2.127", beta: "1.2.128-beta.2" };
const STUDIO_ID = "mock-remote";

export function applyBrowserMockUpdateGate(ade: AnyApi, deps: { lanes: any[]; sessions: any[] }): void {
  const name = scenario();
  if (name !== "self" && name !== "self-download" && name !== "remote") return;
  const self = name === "remote"
    ? { required: false }
    : { required: true, track: "stable", currentVersion: "1.2.126", minimumVersion: "1.2.127", targetVersion: "1.2.127" };
  const state = {
    self,
    minimum: MINIMUM,
    latest: LATEST,
    downloadUrl: "https://ade-app.dev/download",
    install: name === "self-download" ? "download" : "updater",
    packageManagerCommand: flag("mockUpdateGateBrew") ? "brew upgrade --cask ade" : null,
    answeredAt: Date.now(),
  };
  ade.clientUpdateGate = {
    getState: async () => state,
    refresh: async () => ({ ...state, answeredAt: Date.now() }),
    onChange: () => () => {},
    quit: async () => false,
  };
  if (name !== "remote") {
    applySelfUpdater(ade);
    return;
  }
  applyOldStudio(ade, deps);
}

/** A pretend updater: check, a two-second download, then a restart that does not start. */
function applySelfUpdater(ade: AnyApi): void {
  const listeners = new Set<(snapshot: any) => void>();
  let snapshot: any = {
    status: "idle",
    currentVersion: "1.2.126",
    latestKnownVersion: "1.2.126",
    version: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    releaseNotesUrl: null,
    error: null,
    errorDetails: null,
    recentlyInstalled: null,
    parked: null,
    lastInstallFailed: null,
    autoApplyPending: null,
    autoApplySuppressedUntil: null,
    latestByTrack: LATEST,
  };
  const patch = (next: Record<string, unknown>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener(snapshot);
  };
  ade.updateGetState = async () => snapshot;
  ade.onUpdateEvent = (listener: (next: any) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  ade.updateCheckForUpdates = async () => {
    patch({ status: "checking", error: null });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    for (const percent of [12, 38, 64, 91]) {
      patch({ status: "downloading", version: "1.2.127", progressPercent: percent });
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    }
    patch({ status: "ready", version: "1.2.127", latestKnownVersion: "1.2.127", progressPercent: null });
  };
  ade.updateGetInstallImpact = async () => ({ checked: true, chats: [], cliSessions: 0, terminals: 0, connectedPhones: [] });
  ade.updateQuitAndInstall = async () => false;
}

/** Studio Mac is connected on 1.2.120 and holds one lane and one chat of this project. */
function applyOldStudio(ade: AnyApi, deps: { lanes: any[]; sessions: any[] }): void {
  const baseSnapshot = ade.remoteRuntime.getConnectionSnapshot;
  const oldVersion = "1.2.120";
  ade.remoteRuntime.getConnectionSnapshot = async () => {
    const snapshot = await baseSnapshot();
    return {
      ...snapshot,
      connections: snapshot.connections.map((connection: any) => connection.target.id === STUDIO_ID
        ? {
          ...connection,
          version: oldVersion,
          appVersion: oldVersion,
          capabilities: { ...(connection.capabilities ?? {}), remoteUpdate: true },
          target: { ...connection.target, runtimeBinaryVersion: oldVersion },
        }
        : connection),
      updatedAt: Date.now(),
    };
  };
  ade.remoteRuntime.getUpdateImpact = async () => ({ checked: true, chats: [], cliSessions: 0, terminals: 1 });
  ade.remoteRuntime.updateAndRestart = async (_id: string, targetVersion?: string | null) => ({
    ok: false,
    updateApplied: false,
    currentVersion: oldVersion,
    targetVersion: targetVersion ?? null,
    steps: [],
    message: "Studio Mac did not answer the update request (its ADE is too old).",
  });
  const lane = deps.lanes.find((entry) => entry.laneType !== "primary") ?? deps.lanes[0];
  const chat = deps.sessions.find((entry) => /chat/.test(String(entry.toolType ?? "")));
  if (!lane) return;
  const binding = {
    kind: "remote" as const,
    key: `remote:${STUDIO_ID}:studio-project`,
    targetId: STUDIO_ID,
    runtimeName: "Studio Mac",
    transport: "paired" as const,
    projectId: "studio-project",
    rootPath: "/Users/mock/Projects/ADE",
    displayName: "ADE",
  };
  const studioLane = { ...lane, id: "studio-lane-1", name: "studio/fix-sync", branchRef: "studio/fix-sync" };
  const studioChat = chat
    ? { ...chat, id: "studio-chat-1", laneId: studioLane.id, laneName: studioLane.name, title: "Fix the sync retry on Studio" }
    : null;
  const seedUnion = () => {
    void import("./state/appStore").then(({ rootAppStoreApi }) => {
      rootAppStoreApi.setState({
        crossMachineLanesByMachineId: {
          [STUDIO_ID]: {
            machineId: STUDIO_ID,
            machineName: "Studio Mac",
            targetId: STUDIO_ID,
            projectId: "studio-project",
            binding,
            online: true,
            lanes: [studioLane],
            sessions: studioChat ? [studioChat] : [],
            prs: [],
            lastSyncedAtMs: Date.now(),
          },
        },
      } as never);
    });
  };
  window.setTimeout(seedUnion, 3_000);
  window.setTimeout(seedUnion, 7_000);
}
