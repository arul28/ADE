/**
 * Browser preview of the Work tools pane's catalogue across machines. Fake
 * data only (no real names, ids or keys).
 *
 * `?mockToolsPane=<scenario>` turns it on; pair it with
 * `&mockHostPlatform=win32` for a Windows chat. Without the flag nothing here
 * runs. The chat runs on "This PC" (Windows); the account also has "Studio
 * Mac" (connected) and "build-box" (Linux, online, not connected).
 *  - `idle`: no device choice, nothing running.
 *  - `live`: this chat's iPhone is on Studio Mac (`ade devices use
 *    ios@"Studio Mac"`), booted there; the agent is tapping in it, and a
 *    test run is going here.
 *  - `leftover`: as `idle`, and the chat left code and an emulator on
 *    build-box: one Clean up line.
 */

type AnyApi = Record<string, any>;

const THIS_PC = { machineKey: "mk_this_pc", name: "This PC" };
const STUDIO = { machineKey: "mk_studio_mac", name: "Studio Mac", targetId: "mock-remote" };
const BUILD_BOX = { machineKey: "mk_build_box", name: "build-box" };

function scenario(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("mockToolsPane");
  } catch {
    return null;
  }
}

function isChatRow(row: any): boolean {
  return typeof row?.toolType === "string" && /chat|claude|codex|cursor|opencode|droid|pi|muse/.test(row.toolType) && !/^shell$/.test(row.toolType);
}

export function applyBrowserMockToolsPane(
  api: AnyApi,
  deps: {
    sessions: any[];
    emitChatEvent: (sessionId: string, event: Record<string, unknown>) => void;
  },
): void {
  const which = scenario();
  if (!which) return;
  const live = which === "live";
  const leftover = which === "leftover";
  const sources = new Map<string, Record<string, unknown>>();
  const chosen = live
    ? { ios: { kind: "machine", machineKey: STUDIO.machineKey, machineName: STUDIO.name, chosenAt: new Date().toISOString() } }
    : {};

  // The chat's work on other machines.
  const studioUse = {
    machineKey: STUDIO.machineKey,
    machineName: STUDIO.name,
    machinePlatform: "darwin",
    projectId: "mock-project-studio",
    projectRootPath: "/Users/mock/Projects/ADE",
    terminalIds: [],
    workCopyLaneId: "remote-work-studio",
    usesSimulator: true,
    lastStartedAt: new Date(Date.now() - 30_000).toISOString(),
  };
  const buildBoxUse = {
    machineKey: BUILD_BOX.machineKey,
    machineName: BUILD_BOX.name,
    machinePlatform: "linux",
    projectId: "mock-project-build-box",
    projectRootPath: "/home/mock/ADE",
    terminalIds: ["t-nvidia"],
    workCopyLaneId: "remote-work-buildbox",
    usesSimulator: false,
    usesAndroidEmulator: true,
    lastStartedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  };
  for (const row of deps.sessions) {
    if (!isChatRow(row)) continue;
    row.remoteWork = live ? [studioUse] : leftover ? [buildBoxUse] : [];
    row.remoteWorkActiveMachineKeys = live ? [STUDIO.machineKey] : [];
    if (live) {
      row.status = "running";
      row.runtimeState = "running";
      row.endedAt = null;
      row.currentTurnStartedAt = new Date(Date.now() - 120_000).toISOString();
    }
  }

  const chat = api.agentChat ?? {};
  api.agentChat = {
    ...chat,
    getDeviceSources: async (args: { sessionId: string }) => ({
      sessionId: args.sessionId,
      sources: sources.get(args.sessionId) ?? chosen,
    }),
    setDeviceSource: async (args: { sessionId: string; kind: string; source: { kind: string; machineKey?: string; machineName?: string } }) => {
      const next = { ...(sources.get(args.sessionId) ?? chosen) } as Record<string, unknown>;
      if (args.source.kind === "here") delete next[args.kind];
      else next[args.kind] = { kind: "machine", machineKey: args.source.machineKey, machineName: args.source.machineName, chosenAt: new Date().toISOString() };
      sources.set(args.sessionId, next);
      return { sessionId: args.sessionId, sources: next };
    },
  };

  const account = api.account ?? {};
  api.account = {
    ...account,
    getLocalMachineIdentity: async () => ({ machineKey: THIS_PC.machineKey, deviceId: "dev_this_pc", name: THIS_PC.name }),
    listMachines: async () => ({
      state: "ok",
      message: null,
      machines: [
        { machineKey: THIS_PC.machineKey, deviceId: "dev_this_pc", name: THIS_PC.name, platform: "win32", deviceType: "desktop", reachableEndpoints: [], lastSeenAt: Date.now(), online: true },
        { machineKey: STUDIO.machineKey, deviceId: "mock-studio", name: STUDIO.name, platform: "darwin", deviceType: "desktop", reachableEndpoints: [], lastSeenAt: Date.now(), online: true },
        { machineKey: BUILD_BOX.machineKey, deviceId: "dev_build_box", name: BUILD_BOX.name, platform: "linux", deviceType: "desktop", reachableEndpoints: [], lastSeenAt: Date.now() - 60_000, online: true },
      ],
    }),
  };

  // This PC cannot run an iPhone; the Studio Mac's copy has a booted one in `live`.
  const ios = api.iosSimulator ?? {};
  const isStudio = (pin: any) => pin?.kind === "remote" && pin.targetId === STUDIO.targetId;
  api.iosSimulator = {
    ...ios,
    getStatus: async (pin?: any) => (isStudio(pin)
      ? ios.getStatus?.(pin)
      : { platform: "win32", supported: false, tools: [], activeDevice: null, activeSession: null, remoteHolder: null, deviceSession: null, laneDevice: null, helper: null }),
    deviceList: async (args?: { laneId?: string | null }, pin?: any) => {
      if (isStudio(pin) && live && args?.laneId === studioUse.workCopyLaneId) {
        return {
          installed: [{ udid: "studio-17", name: "iPhone 17", state: "Booted", runtime: "iOS 26.3", family: "iphone", isAvailable: true }],
          lane: { laneId: args.laneId, udid: "studio-17", name: "iPhone 17", origin: "created", family: "iphone", runtime: "iOS 26.3", createdAt: new Date().toISOString() },
          owners: [],
          disk: null,
        };
      }
      return ios.deviceList?.(args, pin);
    },
  };

  // The Studio Mac answers without the freeze note the general preview shows.
  const remoteRuntime = api.remoteRuntime ?? {};
  const calm = (snapshot: any) => (snapshot?.connections
    ? { ...snapshot, connections: snapshot.connections.map((entry: any) => ({ ...entry, hostStall: null })) }
    : snapshot);
  api.remoteRuntime = {
    ...remoteRuntime,
    getConnectionSnapshot: async () => calm(await remoteRuntime.getConnectionSnapshot?.()),
    onConnectionSnapshotChanged: (listener: (next: any) => void) =>
      remoteRuntime.onConnectionSnapshotChanged?.((next: any) => listener(calm(next))) ?? (() => {}),
  };

  const remoteWork = api.remoteWork ?? {};
  api.remoteWork = {
    ...remoteWork,
    list: async () => [],
    delete: async () => ({ deleted: true }),
  };

  // `live`: the agent drives the iPhone on the Studio Mac and runs the tests here.
  if (live) {
    // Again every few seconds for a minute: a pane opened after the first
    // send still hears a call in flight (the same item, so nothing doubles).
    let sends = 0;
    const timer = window.setInterval(() => {
      sends += 1;
      if (sends > 20) window.clearInterval(timer);
      for (const row of deps.sessions) {
        if (!isChatRow(row)) continue;
        deps.emitChatEvent(row.id, {
          type: "command",
          command: "ade apple tap \"General\" --machine \"Studio Mac\"",
          cwd: "/",
          output: "",
          itemId: `tap-${row.id}`,
          status: "running",
        });
        deps.emitChatEvent(row.id, {
          type: "command",
          command: "npm test -- --run apps/desktop",
          cwd: "/",
          output: "",
          itemId: `test-${row.id}`,
          status: "running",
        });
      }
    }, 3_000);
  }
}
