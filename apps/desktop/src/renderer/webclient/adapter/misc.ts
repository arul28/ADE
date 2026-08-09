import {
  EMPTY_AGENT_TOOLS_CACHE_SNAPSHOT,
  peerToRuntimeDeviceState,
  type AgentChatSession,
  type AiConfig,
  type CtoAttentionState,
  type CtoOnboardingState,
  type CtoSnapshot,
  type GitHubStatus,
  type PersonalChatStreamEventsResult,
  type SyncDeviceRuntimeState,
  type SyncRoleSnapshot,
} from "../../../shared/types";
import { KEYBINDING_DEFINITIONS } from "../../../shared/keybindings";
import { getStoredZoomLevel, zoomFactorForDisplay, zoomFactorForLevel } from "../../lib/zoom";
import { chatSessionFromRemoteSummary } from "./infra/chatSessionShape";
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

import type {
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
  OpenCodeProviderAuthMethods,
  PiAuthStatusEvent,
  PiLoginProvider,
} from "../../../shared/types";

export function createMiscNamespaces(infra: AdapterInfra): MiscNamespaces {
  const { client, commands, events, localState, state } = infra;

  function call<T>(
    action: string,
    args: unknown,
    // Mirror CommandCaller's Fallback<T>: an eager value, or a lazy resolver
    // that may throw/reject (used by must-succeed calls with no offline shape).
    fallback: T | (() => T | Promise<T>),
    idempotent = true,
  ): Promise<T> {
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
        state: "disabled",
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
    client.subscribe(() => {
      events.emit("syncStatus", { type: "sync-status", snapshot: syncSnapshot() });
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

  // Desktop delivers ai.opencodeOAuthStatus and ai.piAuthStatus over IPC. The web
  // sync protocol has no push channel for runtime-buffered events, but sign-in
  // status transitions land in the shared runtime event buffer, which we can pull
  // (unfiltered and non-destructively — the cursor is client-driven, so this never
  // starves the personal-chats drain) via personalChats.streamEvents. Drain it only
  // while a sign-in is active and re-emit each payload onto the adapter bus, so the
  // onOpencodeOAuthStatus/onPiAuthStatus subscriptions become live instead of
  // inert. Scoped to active flows to avoid a perpetual background poll.
  const OAUTH_STATUS_POLL_MS = 1_000;
  // Must outlive the longest flow it drains. A Pi device-code sign-in is
  // budgeted at ten minutes host-side, so expiring at five stranded the UI on
  // "Waiting for Pi…" while prompts and the completion event were still coming.
  const OAUTH_STATUS_MAX_MS = 11 * 60_000;
  const AUTH_TERMINAL_STATES: Record<string, Set<string>> = {
    opencodeOAuthStatus: new Set(["connected", "failed", "cancelled", "timeout"]),
    piAuthStatus: new Set(["success", "error"]),
  };
  /** Entries are `${kind}:${providerId}` so both flows can drain at once. */
  const oauthActiveProviders = new Set<string>();
  let oauthDrainCursor: number | null = null;
  let oauthDrainTimer: ReturnType<typeof setTimeout> | null = null;
  let oauthDrainDeadline = 0;

  const streamRuntimeEvents = (cursor: number, limit: number): Promise<PersonalChatStreamEventsResult> =>
    commands.call<PersonalChatStreamEventsResult>(
      "personalChats.streamEvents",
      { cursor, limit },
      { fallback: { events: [], nextCursor: cursor, hasMore: false }, idempotent: true, requireProject: false },
    );

  const stopOAuthDrain = (): void => {
    if (oauthDrainTimer != null) {
      clearTimeout(oauthDrainTimer);
      oauthDrainTimer = null;
    }
    oauthDrainCursor = null;
    oauthActiveProviders.clear();
  };

  const scheduleOAuthPoll = (): void => {
    if (oauthDrainTimer != null) return;
    oauthDrainTimer = setTimeout(() => {
      void pollOAuthStatus();
    }, OAUTH_STATUS_POLL_MS);
  };

  async function pollOAuthStatus(): Promise<void> {
    oauthDrainTimer = null;
    if (oauthDrainCursor == null) return;
    let page: PersonalChatStreamEventsResult;
    try {
      page = await streamRuntimeEvents(oauthDrainCursor, 200);
    } catch {
      if (oauthActiveProviders.size > 0 && Date.now() <= oauthDrainDeadline) scheduleOAuthPoll();
      else stopOAuthDrain();
      return;
    }
    if (oauthDrainCursor == null) return; // torn down mid-poll
    oauthDrainCursor = page.nextCursor;
    for (const event of page.events) {
      if (event.category !== "runtime") continue;
      const payload = event.payload as { kind?: unknown; event?: unknown };
      const kind = typeof payload?.kind === "string" ? payload.kind : "";
      const terminalStates = AUTH_TERMINAL_STATES[kind];
      if (!terminalStates || !payload.event || typeof payload.event !== "object") continue;
      const statusEvent = payload.event as OpenCodeOAuthStatusEvent | PiAuthStatusEvent;
      events.emit(kind as never, statusEvent as never);
      if (typeof statusEvent.providerId === "string" && terminalStates.has(statusEvent.state)) {
        oauthActiveProviders.delete(`${kind}:${statusEvent.providerId}`);
      }
    }
    if (oauthActiveProviders.size === 0 || Date.now() > oauthDrainDeadline) stopOAuthDrain();
    else scheduleOAuthPoll();
  }

  const startOAuthDrain = async (kind: string, providerId: string): Promise<void> => {
    if (providerId) oauthActiveProviders.add(`${kind}:${providerId}`);
    oauthDrainDeadline = Date.now() + OAUTH_STATUS_MAX_MS;
    if (oauthDrainCursor == null && oauthDrainTimer == null) {
      // Advance to the buffer tail before the flow emits, so we skip stale
      // statuses left by a prior flow instead of replaying them.
      let cursor = 0;
      for (let i = 0; i < 64; i++) {
        const page = await streamRuntimeEvents(cursor, 1_000);
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      if (oauthDrainCursor == null) oauthDrainCursor = cursor;
    }
    scheduleOAuthPoll();
  };

  infra.addDispose(stopOAuthDrain);

  const ai: Record<string, unknown> = {
    getStatus: (args?: unknown) => call("ai.getStatus", args, aiStatus()),
    getOpenCodeRuntimeDiagnostics: async () => ({ installed: false, available: false, diagnostics: [] }),
    isOpenCodeInstalled: async () => ({ installed: false, source: "missing" }),
    // The pinned-tools cache is a property of the machine running the desktop
    // app, so a web client has no cache of its own to report and no business
    // kicking a 300 MB fetch on someone else's disk. An empty snapshot is the
    // honest answer: `fetching: false` and no tools, which onboarding renders
    // as the plain detected/not-detected treatment.
    getToolsCache: async () => EMPTY_AGENT_TOOLS_CACHE_SNAPSHOT,
    ensureToolsCache: async () => EMPTY_AGENT_TOOLS_CACHE_SNAPSHOT,
    onToolsCacheEvent: () => () => {},
    storeApiKey: async (provider: string, key: string) => {
      await call("ai.storeApiKey", { provider, key: key ? "__redacted__" : "" }, undefined, false);
    },
    deleteApiKey: async (provider: string) => {
      await call("ai.deleteApiKey", { provider }, undefined, false);
    },
    listApiKeys: async () => [],
    verifyApiKey: async () => ({ ok: false, error: "unsupported" }),
    updateConfig: async (config: Partial<AiConfig>) => {
      await call("ai.updateConfig", config, undefined, false);
    },
    opencodeAuthMethods: () =>
      call<{ methods: OpenCodeProviderAuthMethods }>("ai.opencodeAuthMethods", undefined, { methods: {} }),
    // Starting an OAuth flow has no meaningful offline fallback shape, so let it
    // reject when the host is unreachable rather than resolving to a fake result.
    // Begin draining the runtime buffer for status transitions before issuing the
    // start so the flow's own events aren't missed.
    opencodeOAuthStart: async (args: unknown) => {
      const providerId = oauthProviderId(args);
      await startOAuthDrain("opencodeOAuthStatus", providerId);
      try {
        return await call<OpenCodeOAuthStartResult>(
          "ai.opencodeOAuthStart",
          args,
          unavailableOnHost("OpenCode sign-in is unavailable in the web client while offline"),
          false,
        );
      } catch (error) {
        if (providerId) oauthActiveProviders.delete(`opencodeOAuthStatus:${providerId}`);
        if (oauthActiveProviders.size === 0) stopOAuthDrain();
        throw error;
      }
    },
    opencodeOAuthCancel: (args: unknown) => call<void>("ai.opencodeOAuthCancel", args, undefined, false),
    setOpencodeProviderKey: (args: unknown) =>
      call<{ ok: boolean; error?: string }>(
        "ai.setOpencodeProviderKey",
        args,
        { ok: false, error: "OpenCode provider keys are unavailable in the web client while offline" },
        false,
      ),
    clearOpencodeProviderKey: (args: unknown) =>
      call<{ ok: boolean; error?: string }>(
        "ai.clearOpencodeProviderKey",
        args,
        { ok: false, error: "OpenCode provider keys are unavailable in the web client while offline" },
        false,
      ),
    refreshModelsDev: () =>
      call<{ lastFetchedAt: number | null }>("ai.refreshModelsDev", undefined, { lastFetchedAt: null }),
    onOpencodeOAuthStatus: (cb: (status: OpenCodeOAuthStatusEvent) => void) =>
      events.on("opencodeOAuthStatus" as never, cb as never),
    piLoginProviders: () => call<PiLoginProvider[]>("ai.piLoginProviders", undefined, []),
    // Pi's sign-in blocks on prompts that only the host can answer, so an
    // offline web client has no honest fallback shape here either.
    piLoginStart: async (args: unknown) => {
      const providerId = oauthProviderId(args);
      await startOAuthDrain("piAuthStatus", providerId);
      try {
        return await call<{ ok: boolean; error?: string }>(
          "ai.piLoginStart",
          args,
          unavailableOnHost("Pi sign-in is unavailable in the web client while offline"),
          false,
        );
      } catch (error) {
        if (providerId) oauthActiveProviders.delete(`piAuthStatus:${providerId}`);
        if (oauthActiveProviders.size === 0) stopOAuthDrain();
        throw error;
      }
    },
    piLoginSubmit: (args: unknown) =>
      call<{ ok: boolean; error?: string }>(
        "ai.piLoginSubmit",
        args,
        { ok: false, error: "Pi sign-in is unavailable in the web client while offline" },
        false,
      ),
    piLoginCancel: (args: unknown) => call<void>("ai.piLoginCancel", args, undefined, false),
    onPiAuthStatus: (cb: (status: PiAuthStatusEvent) => void) =>
      events.on("piAuthStatus" as never, cb as never),
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
    // A snapshot fallback here would echo the settings back as if they were
    // stored: Settings renders "Saved" and the write is gone. Fail loudly
    // instead when the host has no descriptor for it.
    save: (candidate: unknown) => call<Record<string, unknown>>(
      "projectConfig.save",
      { candidate },
      unavailableOnHost("That machine is running an older ADE that can't save these settings."),
      false,
    ),
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

  const zoom = createZoomNamespace(infra);
  const localNamespaces = createLocalPersistenceNamespaces(localState);

  const rebase: Record<string, unknown> = {
    scanNeeds: () => call("rebase.scanNeeds", {}, []),
    dismiss: async (laneId: string) => {
      await call("rebase.dismiss", { laneId }, undefined, false);
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
    cto: createCtoNamespace(call, localState),
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

function createZoomNamespace(infra: AdapterInfra): Record<string, unknown> {
  const { localState } = infra;
  function setCssZoom(factor: number): void {
    if (typeof document === "undefined") return;
    try {
      document.documentElement?.style?.setProperty("--ade-web-zoom-factor", String(factor));
      // Zoom the <body>, not the root element: percentages resolve across the
      // zoom boundary, so body/#root still measure exactly one viewport at every
      // level (verified in Chrome 150 and Chromium 146 — no page scrollbar in or
      // out), while the root element is the one place engines have historically
      // reserved for browser/pinch zoom.
      const bodyStyle = document.body?.style as (CSSStyleDeclaration & { zoom?: string }) | undefined;
      if (bodyStyle) bodyStyle.zoom = String(factor);
    } catch {
      // A display preference must never take the adapter down — this also runs
      // during install, where the document may be a partial stub.
    }
  }
  // AppShell re-applies the stored level on mount; doing it at install too means
  // a reload paints at the user's zoom instead of flashing 100% first.
  setCssZoom(zoomFactorForDisplay(getStoredZoomLevel()));
  return {
    getLevel: () => localState.get("zoomLevel", 0),
    setLevel: (level: number) => {
      localState.set("zoomLevel", level);
      setCssZoom(zoomFactorForLevel(level));
    },
    getFactor: () => zoomFactorForLevel(localState.get("zoomLevel", 0)),
    onCommand: () => () => {},
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

// Mirrors createMiscNamespaces' local `call`: the fallback is either an eager
// value or a lazy resolver that may throw for calls with no offline shape.
type MiscCall = <T>(
  action: string,
  args: unknown,
  fallback: T | (() => T | Promise<T>),
  idempotent?: boolean,
) => Promise<T>;

// The onboarding wizard is a desktop-first flow — the host registers no
// `cto.*Onboarding` descriptors, and the wizard itself writes through
// cto.updateIdentity, which this namespace deliberately leaves unwired. Left to
// the fallback proxy the reads resolve to null, and CtoPage then parks forever:
// its ensure-session effect bails while onboardingState is null, so the chat
// never starts. Synthesize a completed state in browser-local storage instead,
// so the web CTO opens straight into the chat.
const WEB_CTO_ONBOARDING_KEY = "ctoOnboarding";

function createCtoOnboardingShims(localState: AdapterInfra["localState"]): Record<string, unknown> {
  // "identity" is the step CtoPage treats as completing onboarding, so the
  // default reads as done without inventing a completion timestamp.
  const read = (): CtoOnboardingState =>
    localState.get<CtoOnboardingState>(WEB_CTO_ONBOARDING_KEY, { completedSteps: ["identity"] });
  const write = (next: CtoOnboardingState): CtoOnboardingState => {
    localState.set(WEB_CTO_ONBOARDING_KEY, next);
    return next;
  };
  return {
    getOnboardingState: async (): Promise<CtoOnboardingState> => read(),
    dismissOnboarding: async (): Promise<CtoOnboardingState> =>
      write({ ...read(), dismissedAt: new Date().toISOString() }),
    resetOnboarding: async (): Promise<CtoOnboardingState> => write({ completedSteps: [] }),
  };
}

// Wired method-by-method on purpose. The host registers every `cto.*` action as
// viewerAllowed, including `setLinearToken`/`clearLinearToken`, so completing
// this namespace mechanically would hand any connected browser write access to
// the host's Linear credential store. Only reads and the session ensure are
// wired; identity/token writes stay with the fallback proxy.
function createCtoNamespace(
  call: MiscCall,
  localState: AdapterInfra["localState"],
): NonNullable<Window["ade"]["cto"]> {
  return {
    ...createCtoOnboardingShims(localState),
    getState: (args?: unknown) => call<CtoSnapshot>(
      "cto.getState",
      { recentLimit: asRecord(args).recentLimit ?? 20 },
      unavailableOnHost("The CTO isn't available on the connected ADE host."),
    ),
    // Materializes the primary lane's CTO chat session, so it is a write: never
    // let it resolve to a fabricated session the chat pane would then address.
    ensureSession: async (args?: unknown) => {
      const summary = await call<Record<string, unknown>>(
        "cto.ensureSession",
        args,
        unavailableOnHost("The CTO chat isn't available on the connected ADE host."),
        false,
      );
      return chatSessionFromRemoteSummary(summary);
    },
    getAttention: () => call<CtoAttentionState>(
      "cto.getAttention",
      {},
      { status: "unknown", awaitingInput: false, since: null },
    ),
    // The host registers this one `viewerAllowed`, and the CTO tab ships on web
    // now, so leaving it unwired made the Linear panel fall through to the
    // fallback proxy and report a permanently disconnected Linear.
    getLinearConnectionStatus: () => call("cto.getLinearConnectionStatus", {}, {
      tokenStored: false,
      connected: false,
      authMode: null,
      tokenExpiresAt: null,
      oauthConfigured: false,
      message: "Linear status is unavailable while disconnected from this machine.",
      checkedAt: new Date().toISOString(),
    }),
    getLinearProjects: () => call("cto.getLinearProjects", {}, []),
    getLinearQuickView: () => call("cto.getLinearQuickView", {}, null),
    getLinearIssuePickerData: () => call("cto.getLinearIssuePickerData", {}, null),
    searchLinearIssues: (args?: unknown) => call("cto.searchLinearIssues", args, { issues: [] }),
  } as unknown as NonNullable<Window["ade"]["cto"]>;
}

function createOrchestrationNamespace(call: MiscCall): Partial<Window["ade"]["orchestration"]> {
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

function createUsageStubs(call: MiscCall): Partial<Window["ade"]["usage"]> {
  return {
    getAdeStats: (args = {}) => call("usage.getAdeStats", args, null),
    getSnapshot: () => call("usage.getQuotaSnapshot", {}, null),
    // Refresh is the user pressing the button: mark it non-idempotent so it
    // reaches the host instead of replaying a cached read, and so a failure
    // surfaces rather than resolving to a fake null snapshot.
    refresh: () => call("usage.refreshQuota", {}, null, false),
    // refreshHistory is deliberately NOT mapped onto usage.refreshQuota: the
    // host keeps the cost-log rescan decoupled from quota polling, so aliasing
    // them would do unrelated work and still leave the stats stale. It needs
    // its own descriptor. onUpdate/noteDemand have no streaming descriptor at
    // all; all three stay with the fallback proxy rather than faking liveness.
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
    opencodeProviders: [],
    opencodeProvidersStale: true,
    modelsDevLastFetchedAt: null,
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

function oauthProviderId(args: unknown): string {
  const providerId = asRecord(args).providerId;
  return typeof providerId === "string" ? providerId : "";
}

/**
 * Fallback for a host call that has no honest offline shape: reject rather than
 * resolve to a fabricated result the caller would go on to act on.
 */
export function unavailableOnHost(message: string): () => never {
  return () => {
    throw new Error(message);
  };
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
