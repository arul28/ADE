import {
  peerToRuntimeDeviceState,
  type GitHubStatus,
  type SyncDeviceRuntimeState,
  type SyncRoleSnapshot,
} from "../../../shared/types";
import { KEYBINDING_DEFINITIONS } from "../../../shared/keybindings";
import type { AdapterInfra, AdeNamespace } from "./types";

export type MiscNamespaces = {
  sync: AdeNamespace<"sync">;
  keybindings: AdeNamespace<"keybindings">;
  onboarding: AdeNamespace<"onboarding">;
  modelPicker: AdeNamespace<"modelPicker">;
  ai: AdeNamespace<"ai">;
  github: AdeNamespace<"github">;
  projectConfig: AdeNamespace<"projectConfig">;
  zoom: AdeNamespace<"zoom">;
  layout: AdeNamespace<"layout">;
  tilingTree: AdeNamespace<"tilingTree">;
  graphState: AdeNamespace<"graphState">;
  rebase: AdeNamespace<"rebase">;
  history: AdeNamespace<"history">;
  cto: NonNullable<Window["ade"]["cto"]>;
  orchestration: Partial<Window["ade"]["orchestration"]>;
  projectSecrets: AdeNamespace<"projectSecrets">;
  transcription: AdeNamespace<"transcription">;
  agentTools: AdeNamespace<"agentTools">;
  adeCli: AdeNamespace<"adeCli">;
  devTools: AdeNamespace<"devTools">;
  localhost: AdeNamespace<"localhost">;
  processes: AdeNamespace<"processes">;
  tests: AdeNamespace<"tests">;
  feedback: AdeNamespace<"feedback">;
  computerUse: AdeNamespace<"computerUse">;
  iosSimulator: AdeNamespace<"iosSimulator">;
  appControl: AdeNamespace<"appControl">;
  builtInBrowser: AdeNamespace<"builtInBrowser">;
  usage: Partial<Window["ade"]["usage"]>;
  review: Partial<Window["ade"]["review"]>;
  automations: AdeNamespace<"automations">;
};

export function createMiscNamespaces(infra: AdapterInfra): MiscNamespaces {
  const { client, commands, events, localState, state } = infra;

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  function syncSnapshot(): SyncRoleSnapshot {
    const status = client.getStatus();
    const now = new Date().toISOString();
    const endpoint = parseEndpoint(status.endpoint);
    const localDevice = {
      deviceId: status.selectedEnvId ?? "ade-web",
      siteId: status.selectedEnvId ?? "ade-web",
      name: typeof navigator === "undefined" ? "ADE Web" : `ADE Web (${navigator.platform || "browser"})`,
      platform: "unknown",
      deviceType: "browser",
      createdAt: status.connectedAt ?? now,
      updatedAt: status.lastSeenAt ?? now,
      lastSeenAt: status.lastSeenAt,
      lastHost: endpoint.host,
      lastPort: endpoint.port,
      tailscaleIp: null,
      ipAddresses: [],
      metadata: {},
    };
    const brainStatus = state.getBrainStatus();
    return {
      mode: status.state === "connected" ? "viewer" : "standalone",
      role: "viewer",
      runtimeMode: "viewer",
      runtimeRole: "viewer",
      localDevice,
      currentBrain: (brainStatus?.brain as unknown as SyncRoleSnapshot["currentBrain"]) ?? null,
      currentRuntime: (brainStatus?.runtime as unknown as SyncRoleSnapshot["currentRuntime"]) ?? null,
      clusterState: null,
      bootstrapToken: null,
      pairingPin: null,
      pairingPinConfigured: false,
      runtimeName: status.hostName,
      pairingConnectInfo: null,
      connectedPeers: brainStatus?.connectedPeers ?? [],
      tailnetDiscovery: {
        state: "idle",
        serviceName: "_ade._tcp",
        servicePort: endpoint.port ?? 0,
        target: endpoint.host,
        updatedAt: status.lastSeenAt,
        error: status.error,
        stderr: null,
      },
      client: {
        state: status.state,
        host: endpoint.host,
        port: endpoint.port,
        connectedAt: status.connectedAt,
        lastSeenAt: status.lastSeenAt,
        latencyMs: null,
        syncLag: null,
        lastRemoteDbVersion: 0,
        brainDeviceId: status.hostDeviceId,
        hostDeviceId: status.hostDeviceId,
        hostName: status.hostName,
        error: status.error,
        message: status.error,
        savedDraft: null,
      },
      transferReadiness: { ready: true, blockers: [], survivableState: [] },
      survivableStateText: "",
      blockingStateText: "",
    } as unknown as SyncRoleSnapshot;
  }

  function localSyncSnapshot(): SyncRoleSnapshot {
    const routed = syncSnapshot();
    const now = new Date().toISOString();
    const localDevice = {
      ...routed.localDevice,
      deviceId: "ade-web",
      siteId: "ade-web",
      name: typeof navigator === "undefined" ? "ADE Web" : `ADE Web (${navigator.platform || "browser"})`,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      lastHost: null,
      lastPort: null,
    };
    return {
      ...routed,
      mode: "standalone",
      localDevice,
      currentBrain: null,
      currentRuntime: null,
      runtimeName: "ADE Web",
      connectedPeers: [],
      tailnetDiscovery: {
        ...routed.tailnetDiscovery,
        state: "idle",
        servicePort: 0,
        target: null,
        error: null,
      },
      client: {
        ...routed.client,
        state: "disconnected",
        host: null,
        port: null,
        connectedAt: null,
        lastSeenAt: null,
        brainDeviceId: null,
        hostDeviceId: null,
        hostName: null,
        error: null,
        message: null,
      },
    };
  }

  function syncDevices(): SyncDeviceRuntimeState[] {
    const snapshot = syncSnapshot();
    const local = snapshot.localDevice;
    const localRuntime: SyncDeviceRuntimeState = {
      ...local,
      isLocal: true,
      isBrain: false,
      isHost: false,
      connectionState: "self",
      connectedAt: snapshot.client.connectedAt,
      lastAppliedAt: null,
      remoteAddress: snapshot.client.host,
      remotePort: snapshot.client.port,
      latencyMs: snapshot.client.latencyMs,
      syncLag: snapshot.client.syncLag,
    };
    const peers = snapshot.connectedPeers.map((peer) => peerToRuntimeDeviceState(peer, {
      appVersion: peer.appVersion,
      appBuild: peer.appBuild,
      bundleIdentifier: peer.bundleIdentifier,
    }));
    return [localRuntime, ...peers];
  }

  infra.addDispose(
    client.onBrainStatus((payload) => {
      state.setBrainStatus(payload);
      events.emit("syncStatus", { type: "sync-status", snapshot: syncSnapshot() });
    })
  );

  infra.addDispose(
    client.subscribe((status) => {
      events.emit("syncStatus", { type: "sync-status", snapshot: syncSnapshot() });
      if (status.state === "connected") {
        // Re-resolve the real GitHub status on (re)connect so a stale/disconnected
        // banner self-heals once the project host is bound and the host's command
        // descriptors are known. (Previously this pushed a hardcoded disconnected
        // status on every connect, which pinned the "GitHub not connected" banner.)
        void (async () => {
          const gh = await call("github.getStatus", {}, githubDisconnectedStatus());
          events.emit("githubStatusChanged", gh);
        })();
      }
    })
  );

  infra.addDispose(
    events.on("githubInvalidated", async () => {
      const status = await call("github.getStatus", {}, githubDisconnectedStatus());
      events.emit("githubStatusChanged", status);
    })
  );

  infra.addDispose(
    events.on("rebaseInvalidated", (event) => {
      events.emit("rebaseEvent", {
        type: "rebase-needs-updated",
        polledAt: event.at,
        needs: [],
      } as never);
    })
  );

  const sync: Record<string, unknown> = {
    getStatus: async () => syncSnapshot(),
    getLocalStatus: async () => localSyncSnapshot(),
    refreshDiscovery: async () => syncSnapshot(),
    listDevices: async () => syncDevices(),
    updateLocalDevice: async (args: unknown) => ({
      ...syncSnapshot().localDevice,
      ...asRecord(args),
      updatedAt: new Date().toISOString(),
    }),
    connectToBrain: async () => syncSnapshot(),
    disconnectFromBrain: async () => syncSnapshot(),
    forgetDevice: async () => syncSnapshot(),
    getTransferReadiness: async () => syncSnapshot().transferReadiness,
    transferBrainToLocal: async () => syncSnapshot(),
    getPin: async () => ({ pin: null }),
    setPin: async () => syncSnapshot(),
    generatePin: async () => syncSnapshot(),
    clearPin: async () => syncSnapshot(),
    getRuntimeName: async () => ({ runtimeName: syncSnapshot().runtimeName }),
    setRuntimeName: async () => syncSnapshot(),
    clearRuntimeName: async () => syncSnapshot(),
    setActiveLanePresence: async (args: unknown) => {
      await call("lanes.presence.announce", args, undefined, false);
    },
    getCloudRelayStatus: async () => ({
      relayWssUrl: "",
      machineKey: "",
      relayUrl: "",
      connected: false,
      activeTunnels: 0,
      relayBridgeValidated: false,
      lastFailureAt: null,
      lastControlOpenAt: null,
      lastBridgeValidationAt: null,
      lastControlError: "unsupported",
      lastError: "unsupported",
    }),
    onEvent: (listener: (event: unknown) => void) => events.on("syncStatus", listener as never),
  };

  const keybindings: Record<string, unknown> = {
    get: async () => ({
      definitions: KEYBINDING_DEFINITIONS,
      overrides: localState.get("keybindingOverrides", []),
    }),
    set: async (overrides: unknown[]) => {
      localState.set("keybindingOverrides", overrides);
      return { definitions: KEYBINDING_DEFINITIONS, overrides };
    },
  };

  const onboarding: Record<string, unknown> = {
    getStatus: async () => onboardingStatus(),
    detectDefaults: async () => ({ tools: [], project: state.getProject() }),
    detectExistingLanes: async () => [],
    setDismissed: async () => onboardingStatus(),
    complete: async () => onboardingStatus(),
    markGlossaryTermSeen: async () => ({ seenTermIds: [] }),
  };

  const modelPicker: Record<string, unknown> = {
    getFavorites: () => call("modelPicker.getFavorites", {}, { favorites: localState.get("modelFavorites", []) }),
    setFavorites: async (favorites: string[]) => {
      localState.set("modelFavorites", favorites);
      return await call("modelPicker.setFavorites", { favorites }, { favorites }, false);
    },
    toggleFavorite: async (modelId: string) => {
      const favorites = new Set(localState.get<string[]>("modelFavorites", []));
      if (favorites.has(modelId)) favorites.delete(modelId);
      else favorites.add(modelId);
      const next = Array.from(favorites);
      localState.set("modelFavorites", next);
      return await call("modelPicker.toggleFavorite", { modelId }, { favorites: next, isFavorite: favorites.has(modelId) }, false);
    },
    getRecents: () => call("modelPicker.getRecents", {}, { recents: localState.get("modelRecents", []) }),
    pushRecent: async (modelId: string) => {
      const recents = [modelId, ...localState.get<string[]>("modelRecents", []).filter((id) => id !== modelId)].slice(0, 12);
      localState.set("modelRecents", recents);
      return await call("modelPicker.pushRecent", { modelId }, { recents }, false);
    },
  };

  const ai: Record<string, unknown> = {
    getStatus: (args?: unknown) => call("ai.getStatus", args, aiStatus()),
    getOpenCodeRuntimeDiagnostics: async () => ({ installed: false, available: false, diagnostics: [] }),
    isOpenCodeInstalled: async () => ({ installed: false, source: "missing" }),
    storeApiKey: async (provider: string, key: string) => {
      await call("ai.storeApiKey", { provider, key: key ? "__redacted__" : "" }, undefined, false);
    },
    deleteApiKey: async (provider: string) => {
      await call("ai.deleteApiKey", { provider }, undefined, false);
    },
    listApiKeys: async () => [],
    verifyApiKey: async () => ({ ok: false, error: "unsupported" }),
    updateConfig: async (config: unknown) => {
      await call("ai.updateConfig", { config }, undefined, false);
    },
  };

  const github: Record<string, unknown> = {
    getStatus: (opts?: unknown) => call("github.getStatus", opts, githubDisconnectedStatus()),
    getRemoteStatus: (opts?: unknown) => call("github.getRemoteStatus", opts, { repo: null, hasOrigin: false }),
    setToken: async () => githubDisconnectedStatus(),
    clearToken: async () => githubDisconnectedStatus(),
    getAppUserAuthStatus: async () => ({ authenticated: false, user: null }),
    startAppUserDeviceAuth: async () => ({ ok: false, error: "unsupported" }),
    pollAppUserDeviceAuth: async () => ({ status: "expired" }),
    clearAppUserAuth: async () => ({ authenticated: false, user: null }),
    detectRepo: async () => null,
    listRepoAutolinks: async () => [],
    getAppInstallationStatus: async () => ({ installed: false, state: "unknown" }),
    createRepoAutolink: async () => null,
    listRepoLabels: async () => [],
    listRepoCollaborators: async () => [],
    listMyRepos: async () => ({ repositories: [], nextCursor: null }),
    // Publishing creates a repo + pushes, so keep it explicitly marked as a
    // mutation and ineligible for adapter read caching.
    publishCurrentProject: (opts?: unknown) => call("github.publishCurrentProject", opts, { ok: false, error: "unsupported" }, false),
    onStatusChanged: (listener: (status: unknown) => void) => events.on("githubStatusChanged", listener as never),
  };

  const projectConfig: Record<string, unknown> = {
    get: () => call("projectConfig.get", {}, projectConfigSnapshot(state.getProject()?.rootPath ?? "")),
    validate: async () => projectConfigSnapshot(state.getProject()?.rootPath ?? "").validation,
    save: (candidate: unknown) => call("projectConfig.save", { candidate }, projectConfigSnapshot(state.getProject()?.rootPath ?? ""), false),
    diffAgainstDisk: async () => ({
      sharedChanged: false,
      localChanged: false,
      sharedHash: "",
      localHash: "",
      approvedSharedHash: null,
      requiresSharedTrust: false,
    }),
    confirmTrust: async () => projectConfigSnapshot(state.getProject()?.rootPath ?? "").trust,
  };

  const zoom = createZoomNamespace(localState, events);
  const localNamespaces = createLocalPersistenceNamespaces(localState);

  const rebase: Record<string, unknown> = {
    scanNeeds: () => call("rebase.scanNeeds", {}, []),
    getNeed: (laneId: string) => call("rebase.getNeed", { laneId }, null),
    dismiss: async (laneId: string) => {
      await call("rebase.dismiss", { laneId }, undefined, false);
    },
    defer: async (laneId: string, until: string) => {
      await call("rebase.defer", { laneId, until }, undefined, false);
    },
    execute: (args: unknown) => call("rebase.execute", args, { ok: false, error: "unsupported" }, false),
    onEvent: (listener: (event: unknown) => void) => events.on("rebaseEvent", listener as never),
  };

  const history: Record<string, unknown> = {
    listOperations: (args?: unknown) => call("history.listOperations", args, []),
    exportOperations: async (args: unknown) => ({ operations: await call("history.listOperations", args, []) }),
  };

  return {
    sync: sync as AdeNamespace<"sync">,
    keybindings: keybindings as AdeNamespace<"keybindings">,
    onboarding: onboarding as AdeNamespace<"onboarding">,
    modelPicker: modelPicker as AdeNamespace<"modelPicker">,
    ai: ai as AdeNamespace<"ai">,
    github: github as AdeNamespace<"github">,
    projectConfig: projectConfig as AdeNamespace<"projectConfig">,
    zoom: zoom as AdeNamespace<"zoom">,
    layout: localNamespaces.layout as AdeNamespace<"layout">,
    tilingTree: localNamespaces.tilingTree as AdeNamespace<"tilingTree">,
    graphState: localNamespaces.graphState as AdeNamespace<"graphState">,
    rebase: rebase as AdeNamespace<"rebase">,
    history: history as AdeNamespace<"history">,
    cto: createCtoNamespace(call),
    orchestration: createOrchestrationNamespace(call),
    projectSecrets: createProjectSecretsNamespace(),
    transcription: createTranscriptionNamespace(),
    agentTools: { detect: async () => [] } as AdeNamespace<"agentTools">,
    adeCli: ({
      getStatus: async () => ({ installed: false, path: null, version: null }),
      installForUser: async () => ({ installed: false, path: null, error: "unsupported" }),
    } as unknown as AdeNamespace<"adeCli">),
    devTools: ({ detect: async () => ({ tools: [] }) } as unknown as AdeNamespace<"devTools">),
    localhost: { probePort: async () => false } as AdeNamespace<"localhost">,
    processes: createProcessStubs() as AdeNamespace<"processes">,
    tests: createTestStubs() as AdeNamespace<"tests">,
    feedback: createFeedbackStubs() as AdeNamespace<"feedback">,
    computerUse: createNativeUnavailableNamespace() as AdeNamespace<"computerUse">,
    iosSimulator: createNativeUnavailableNamespace() as AdeNamespace<"iosSimulator">,
    appControl: createNativeUnavailableNamespace() as AdeNamespace<"appControl">,
    builtInBrowser: createNativeUnavailableNamespace() as AdeNamespace<"builtInBrowser">,
    usage: createUsageStubs(call),
    review: createReviewStubs(),
    automations: createAutomationStubs() as AdeNamespace<"automations">,
  };
}

function createZoomNamespace(localState: AdapterInfra["localState"], events: AdapterInfra["events"]): Record<string, unknown> {
  function setCssZoom(level: number): void {
    const factor = zoomFactor(level);
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--ade-web-zoom-factor", String(factor));
      (document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(factor);
    }
  }
  return {
    getLevel: () => localState.get("zoomLevel", 0),
    setLevel: (level: number) => {
      localState.set("zoomLevel", level);
      setCssZoom(level);
    },
    getFactor: () => zoomFactor(localState.get("zoomLevel", 0)),
    onCommand: () => {
      void events;
      return () => {};
    },
  };
}

function createLocalPersistenceNamespaces(localState: AdapterInfra["localState"]): Pick<MiscNamespaces, "layout" | "tilingTree" | "graphState"> {
  return {
    layout: {
      get: async (layoutId: string) => localState.get(`layout:${layoutId}`, null),
      set: async (layoutId: string, layout: unknown) => {
        localState.set(`layout:${layoutId}`, layout);
      },
    } as AdeNamespace<"layout">,
    tilingTree: {
      get: async (layoutId: string) => localState.get(`tilingTree:${layoutId}`, null),
      set: async (layoutId: string, tree: unknown) => {
        localState.set(`tilingTree:${layoutId}`, tree);
      },
    } as AdeNamespace<"tilingTree">,
    graphState: {
      get: async (projectId: string) => localState.get(`graphState:${projectId}`, null),
      set: async (projectId: string, graphState: unknown) => {
        localState.set(`graphState:${projectId}`, graphState);
      },
    } as AdeNamespace<"graphState">,
  };
}

function createCtoNamespace(call: <T>(action: string, args: unknown, fallback: T, idempotent?: boolean) => Promise<T>): NonNullable<Window["ade"]["cto"]> {
  return {
    getLinearProjects: () => call("cto.getLinearProjects", {}, []),
    getLinearQuickView: () => call("cto.getLinearQuickView", {}, null),
    getLinearIssuePickerData: () => call("cto.getLinearIssuePickerData", {}, null),
    searchLinearIssues: (args?: unknown) => call("cto.searchLinearIssues", args, { issues: [] }),
  } as unknown as NonNullable<Window["ade"]["cto"]>;
}

function createOrchestrationNamespace(call: <T>(action: string, args: unknown, fallback: T, idempotent?: boolean) => Promise<T>): Partial<Window["ade"]["orchestration"]> {
  return {
    runCreate: (args: unknown) => call("orchestration.runCreate", args, { ok: false, error: "unsupported" }, false),
  } as unknown as Partial<Window["ade"]["orchestration"]>;
}

function createProjectSecretsNamespace(): AdeNamespace<"projectSecrets"> {
  return {
    list: async () => ({ secrets: [] }),
    get: async () => ({ value: null }),
    set: async (args: { name?: string }) => ({ name: args.name ?? "", hasValue: false, updatedAt: new Date().toISOString() }),
    delete: async (args: { name?: string }) => ({ deleted: false, name: args.name ?? "" }),
  } as unknown as AdeNamespace<"projectSecrets">;
}

function createTranscriptionNamespace(): AdeNamespace<"transcription"> {
  const status = {
    installed: false,
    binaryInstalled: false,
    modelInstalled: false,
    downloading: false,
    binaryPath: null,
    modelPath: null,
  };
  return {
    transcribe: async () => ({ raw: "", cleaned: "" }),
    status: async () => status,
    downloadModel: async () => status,
    onModelDownloadProgress: () => () => {},
    requestMicAccess: async () => ({ status: "unknown" }),
  } as AdeNamespace<"transcription">;
}

function createProcessStubs(): Record<string, unknown> {
  return {
    listDefinitions: async () => [],
    listRuntime: async () => [],
    start: async () => null,
    stop: async () => null,
    restart: async () => null,
    kill: async () => null,
    startStack: async () => undefined,
    stopStack: async () => undefined,
    restartStack: async () => undefined,
    startGroup: async () => undefined,
    stopGroup: async () => undefined,
    restartGroup: async () => undefined,
    startAll: async () => undefined,
    stopAll: async () => undefined,
    getLogTail: async () => "",
    onEvent: () => () => {},
  };
}

function createTestStubs(): Record<string, unknown> {
  return {
    listSuites: async () => [],
    run: async () => null,
    stop: async () => undefined,
    listRuns: async () => [],
    getLogTail: async () => "",
    onEvent: () => () => {},
  };
}

function createFeedbackStubs(): Record<string, unknown> {
  return {
    prepareDraft: async () => null,
    submitDraft: async () => null,
    list: async () => [],
    onUpdate: () => () => {},
  };
}

function createNativeUnavailableNamespace(): Record<string, unknown> {
  return {
    getStatus: async () => ({ supported: false, available: false, state: "unsupported" }),
    listArtifacts: async () => [],
    listDevices: async () => [],
    onEvent: () => () => {},
  };
}

function createUsageStubs(
  call: <T>(action: string, args: unknown, fallback: T, idempotent?: boolean) => Promise<T>,
): Partial<Window["ade"]["usage"]> {
  return {
    getAdeStats: (args = {}) => call("usage.getAdeStats", args, null),
    getSummary: async () => null,
    listSessions: async () => [],
  } as Partial<Window["ade"]["usage"]>;
}

function createReviewStubs(): Partial<Window["ade"]["review"]> {
  return {
    listRuns: async () => [],
    onEvent: () => () => {},
  } as Partial<Window["ade"]["review"]>;
}

function createAutomationStubs(): Record<string, unknown> {
  return {
    list: async () => [],
    onEvent: () => () => {},
  };
}

function onboardingStatus(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    status: "completed",
    completed: true,
    dismissed: true,
    completedAt: now,
    steps: [],
    help: { seenTermIds: [] },
  };
}

function aiStatus(): Record<string, unknown> {
  return {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: { present: false, source: "missing", path: null },
        auth: { ready: false, mode: "none", detail: null },
      },
      codex: false,
      cursor: false,
      droid: false,
    },
    models: { claude: [], codex: [], cursor: [], droid: [] },
    features: [],
    availableModelIds: [],
  };
}

function githubDisconnectedStatus(): GitHubStatus {
  return {
    tokenStored: false,
    patTokenStored: false,
    tokenDecryptionFailed: false,
    storageScope: "app",
    authSource: "none",
    repo: null,
    hasOrigin: false,
    userLogin: null,
    scopes: [],
    ghCliPath: null,
    ghAuthError: null,
    checkedAt: new Date().toISOString(),
    repoAccessOk: null,
    repoAccessError: null,
    connected: false,
  };
}

function projectConfigSnapshot(rootPath: string): Record<string, unknown> {
  const file = { providerMode: "guest", ai: {}, tools: {}, version: 1 };
  return {
    shared: file,
    local: file,
    effective: { providerMode: "guest", rootPath },
    validation: { ok: true, errors: [], warnings: [] },
    trust: { trusted: true, sharedHash: "", approvedSharedHash: "" },
    paths: {
      sharedPath: rootPath ? `${rootPath}/.ade/config.json` : "",
      localPath: rootPath ? `${rootPath}/.ade/local.json` : "",
    },
  };
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function zoomFactor(level: number): number {
  return Math.round(Math.pow(1.2, level) * 1_000) / 1_000;
}

function parseEndpoint(endpoint: string | null): { host: string | null; port: number | null } {
  if (!endpoint) return { host: null, port: null };
  try {
    const url = new URL(endpoint);
    return { host: url.hostname || null, port: url.port ? Number(url.port) : null };
  } catch {
    return { host: null, port: null };
  }
}
