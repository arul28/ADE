import type {
  OpenProjectBinding,
  ProjectInfo,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import type { BrowserAccountClient } from "../account/client";
import type { AdeSyncClient } from "../sync";
import type { WebMachineSessionManager } from "../workspace/WebMachineSessionManager";
import { createAdeWebAdapter, type AdeWebAdapter } from "./index";

type RemoteBinding = Extract<OpenProjectBinding, { kind: "remote" }>;

/** Walk a dotted member path on an adapter's surface, keeping the receiver. */
function readPath(
  adapter: AdeWebAdapter,
  path: PropertyKey[],
): { parent: unknown; value: unknown } {
  let parent: unknown = adapter.ade;
  let value: unknown = adapter.ade;
  for (const key of path) {
    parent = value;
    value = (value as Record<PropertyKey, unknown> | null | undefined)?.[key];
  }
  return { parent, value };
}

type WebWorkspaceState = {
  version: 1;
  openBindings: RemoteBinding[];
  activeBindingKey: string | null;
  activeSurface: "hub" | "project" | "chats";
  selectedHubTargetId: string | null;
  selectedChatsTargetId: string | null;
};

const WORKSPACE_STORAGE_PREFIX = "ade-web:workspace:v1:";

function projectInfo(project: {
  id: string;
  rootPath: string | null;
  displayName: string;
  defaultBaseRef?: string | null;
} | {
  projectId: string;
  rootPath: string | null;
  displayName: string;
  defaultBaseRef?: string | null;
}): ProjectInfo {
  const projectId = "id" in project ? project.id : project.projectId;
  return {
    rootPath: project.rootPath || `remote:${projectId}`,
    displayName: project.displayName,
    baseRef: project.defaultBaseRef ?? "main",
  };
}

function bindingKey(targetId: string, projectId: string): string {
  return `remote:${targetId}:${projectId}`;
}

function gitOriginUrl(project: {
  repoOwner?: string | null;
  repoName?: string | null;
}): string | null {
  return project.repoOwner && project.repoName
    ? `https://github.com/${project.repoOwner}/${project.repoName}`
    : null;
}

function emptyWorkspaceState(): WebWorkspaceState {
  return {
    version: 1,
    openBindings: [],
    activeBindingKey: null,
    activeSurface: "hub",
    selectedHubTargetId: null,
    selectedChatsTargetId: null,
  };
}

function readWorkspaceState(accountKey: string): WebWorkspaceState {
  try {
    const value = JSON.parse(localStorage.getItem(`${WORKSPACE_STORAGE_PREFIX}${accountKey}`) ?? "null") as Partial<WebWorkspaceState> | null;
    if (!value || value.version !== 1) return emptyWorkspaceState();
    return {
      version: 1,
      openBindings: Array.isArray(value.openBindings)
        ? value.openBindings.filter((entry): entry is RemoteBinding => (
            Boolean(entry)
            && entry.kind === "remote"
            && typeof entry.key === "string"
            && typeof entry.targetId === "string"
            && typeof entry.projectId === "string"
          ))
        : [],
      activeBindingKey: typeof value.activeBindingKey === "string" ? value.activeBindingKey : null,
      activeSurface:
        value.activeSurface === "hub"
        || value.activeSurface === "project"
        || value.activeSurface === "chats"
          ? value.activeSurface
          : typeof value.activeBindingKey === "string"
            ? "project"
            : "hub",
      selectedHubTargetId: typeof value.selectedHubTargetId === "string" ? value.selectedHubTargetId : null,
      selectedChatsTargetId: typeof value.selectedChatsTargetId === "string" ? value.selectedChatsTargetId : null,
    };
  } catch {
    return emptyWorkspaceState();
  }
}

export type FederatedWebAdapter = {
  ade: Window["ade"];
  getOpenBindings(): RemoteBinding[];
  getActiveBinding(): RemoteBinding | null;
  getDisplayedTargetId(): string | null;
  getSelectedHubTargetId(): string | null;
  setSelectedHubTargetId(targetId: string | null): void;
  activateHub(): void;
  getSelectedChatsTargetId(): string | null;
  openProject(targetId: string, projectId: string): Promise<RemoteBinding>;
  activateChats(targetId: string): Promise<void>;
  forgetEnvironment(targetId: string): Promise<void>;
  restore(): Promise<"project" | "chats" | null>;
  subscribeActiveAdapter(listener: () => void): () => void;
  dispose(): void;
};

export function createFederatedWebAdapter({
  manager,
  accountClient,
  accountKey,
  fallbackClient,
}: {
  manager: WebMachineSessionManager;
  accountClient: BrowserAccountClient;
  accountKey: string;
  fallbackClient: AdeSyncClient;
}): FederatedWebAdapter {
  let workspace = readWorkspaceState(accountKey);
  const fallbackAdapter = createAdeWebAdapter(fallbackClient, [], accountClient);
  const adaptersByBinding = new Map<string, {
    kind: "project" | "chats";
    targetId: string;
    client: AdeSyncClient;
    adapter: AdeWebAdapter;
  }>();
  const adapters = new Set<AdeWebAdapter>([fallbackAdapter]);
  let currentAdapter = fallbackAdapter;
  let activeBinding: RemoteBinding | null =
    workspace.openBindings.find((entry) => entry.key === workspace.activeBindingKey) ?? null;
  const projectListeners = new Set<(project: ProjectInfo | null) => void>();
  const bindingListeners = new Set<(binding: OpenProjectBinding | null) => void>();
  const connectionListeners = new Set<(snapshot: RemoteRuntimeConnectionSnapshot) => void>();
  const activeAdapterListeners = new Set<() => void>();

  const persist = () => {
    try {
      localStorage.setItem(`${WORKSPACE_STORAGE_PREFIX}${accountKey}`, JSON.stringify(workspace));
    } catch {
      // Hardened/private browser contexts may reject local storage.
    }
  };

  const extraProjectsByTarget = (): Map<string, RemoteRuntimeProjectRecord[]> => {
    const result = new Map<string, RemoteRuntimeProjectRecord[]>();
    for (const binding of workspace.openBindings) {
      const entries = result.get(binding.targetId) ?? [];
      entries.push({
        projectId: binding.projectId,
        rootPath: binding.rootPath,
        displayName: binding.displayName,
        addedAt: 0,
        lastOpenedAt: 0,
        gitOriginUrl: binding.gitOriginUrl ?? null,
        catalogVisibility: "recent",
        registrationSource: "runtime-auto",
        icon: binding.iconDataUrl
          ? { dataUrl: binding.iconDataUrl, sourcePath: null, mimeType: null }
          : null,
      });
      result.set(binding.targetId, entries);
    }
    return result;
  };

  const getConnectionSnapshot = () =>
    manager.getConnectionSnapshot(extraProjectsByTarget());

  let managerDispose = () => {};

  /**
   * An unpinned subscription means "events for whatever project is displayed".
   * The surface is a proxy over a per-binding adapter, so a listener registered
   * while tab A was in front would otherwise stay attached to A's adapter after
   * the user switches to B — still live, still delivering A's events. The web
   * shell used to paper over that by remounting the whole app on every swap.
   *
   * Instead every unpinned subscription handed out through the proxy is
   * recorded here and re-attached on swap: detach from the outgoing adapter,
   * attach to the incoming one, keeping the caller's own unsubscribe valid
   * throughout. That is exactly the semantic the caller asked for, and it makes
   * the remount unnecessary.
   *
   * INVARIANT: a subscription pinned to a binding (one carrying a binding in
   * its arguments) is never recorded and never re-attached — it belongs to that
   * binding's machine for its whole life. See the `pinned` branch in
   * `dynamicMember`.
   */
  type DurableSubscription = {
    path: PropertyKey[];
    args: unknown[];
    detach: (() => void) | null;
  };
  const durableSubscriptions = new Set<DurableSubscription>();

  /** Attach one recorded subscription to `adapter`, or leave it detached. */
  const attachDurableSubscription = (
    adapter: AdeWebAdapter,
    entry: DurableSubscription,
  ): (() => void) | null => {
    try {
      const { parent, value } = readPath(adapter, entry.path);
      if (typeof value !== "function") return null;
      const result = Reflect.apply(value, parent, entry.args);
      return typeof result === "function" ? (result as () => void) : null;
    } catch {
      // An adapter that cannot serve this subscription leaves it detached
      // rather than failing the tab switch; the next swap retries.
      return null;
    }
  };

  const detachDurableSubscription = (entry: DurableSubscription): void => {
    try {
      entry.detach?.();
    } catch {
      // A disposed adapter can throw on detach; the attachment dies with it.
    }
    entry.detach = null;
  };

  /** Record a subscription and hand the caller an unsubscribe that outlives swaps. */
  const registerDurableSubscription = (entry: DurableSubscription): (() => void) => {
    durableSubscriptions.add(entry);
    return () => {
      if (!durableSubscriptions.delete(entry)) return;
      detachDurableSubscription(entry);
    };
  };

  const isSubscriptionMember = (path: PropertyKey[]): boolean => {
    const member = String(path[path.length - 1] ?? "");
    return /^on[A-Z]/.test(member) || /^subscribe/.test(member);
  };

  const setCurrentAdapter = (adapter: AdeWebAdapter) => {
    if (currentAdapter === adapter) return;
    currentAdapter = adapter;
    for (const entry of durableSubscriptions) {
      // Detach first: overlapping attachments would deliver both projects'
      // events to the same listener for the width of this loop.
      detachDurableSubscription(entry);
      entry.detach = attachDurableSubscription(adapter, entry);
    }
    for (const listener of activeAdapterListeners) listener();
  };

  const adapterForBinding = (binding: RemoteBinding): AdeWebAdapter => {
    const client = manager.getClient(binding.targetId);
    if (!client) throw new Error("The machine is not connected.");
    const existing = adaptersByBinding.get(binding.key);
    if (existing?.client === client) return existing.adapter;
    if (existing) {
      existing.adapter.dispose();
      adapters.delete(existing.adapter);
    }
    const adapter = createAdeWebAdapter(
      client,
      manager.getCatalog(binding.targetId),
      accountClient,
    );
    adapter.bindProject(projectInfo(binding), binding.projectId);
    adaptersByBinding.set(binding.key, {
      kind: "project",
      targetId: binding.targetId,
      client,
      adapter,
    });
    adapters.add(adapter);
    return adapter;
  };

  const adapterForChats = (targetId: string): AdeWebAdapter => {
    const client = manager.getClient(targetId);
    if (!client) throw new Error("The machine is not connected.");
    const key = `chats:${targetId}`;
    const existing = adaptersByBinding.get(key);
    if (existing?.client === client) return existing.adapter;
    if (existing) {
      existing.adapter.dispose();
      adapters.delete(existing.adapter);
    }
    const adapter = createAdeWebAdapter(client, manager.getCatalog(targetId), accountClient);
    adapter.bindProject(null);
    adaptersByBinding.set(key, { kind: "chats", targetId, client, adapter });
    adapters.add(adapter);
    return adapter;
  };

  const disposeClosedProjectAdapters = (bindings: RemoteBinding[]) => {
    const referencedKeys = new Set(bindings.map((binding) => binding.key));
    for (const [key, entry] of adaptersByBinding) {
      if (entry.kind !== "project" || referencedKeys.has(key)) continue;
      entry.adapter.dispose();
      adapters.delete(entry.adapter);
      adaptersByBinding.delete(key);
      if (currentAdapter === entry.adapter) setCurrentAdapter(fallbackAdapter);
    }
  };

  const rememberBinding = (binding: RemoteBinding) => {
    workspace = {
      ...workspace,
      openBindings: workspace.openBindings.some((entry) => entry.key === binding.key)
        ? workspace.openBindings.map((entry) => entry.key === binding.key ? binding : entry)
        : [...workspace.openBindings, binding],
      activeBindingKey: binding.key,
      activeSurface: "project",
    };
    activeBinding = binding;
    manager.setProtectedTargetId(binding.targetId);
    persist();
  };

  // A user-initiated activation is authoritative for the whole time it is in
  // flight. Opening a project makes its host broadcast a catalog, and every
  // machine keeps broadcasting its own while we wait, so without this the
  // host-driven rebind below can fire against the binding the user is in the
  // middle of leaving and write it back over the one they asked for.
  let activationsInFlight = 0;

  const openProject = async (targetId: string, projectId: string): Promise<RemoteBinding> => {
    activationsInFlight += 1;
    try {
      const { project } = await manager.openProject(targetId, projectId);
      const info = projectInfo(project);
      const environment = manager.getSession(targetId)?.environment;
      const binding: RemoteBinding = {
        kind: "remote",
        key: bindingKey(targetId, project.id),
        targetId,
        runtimeName: environment?.machineName ?? "Machine",
        hostname: environment?.hostIdentity?.name,
        projectId: project.id,
        rootPath: info.rootPath,
        displayName: info.displayName,
        gitOriginUrl: gitOriginUrl(project),
        iconDataUrl: project.iconDataUrl ?? null,
      };
      // The guard has to span the commit, not just the await: binding the new
      // adapter can drive the client and the manager synchronously, and until
      // `rememberBinding` runs `activeBinding` still names the tab being left.
      setCurrentAdapter(adapterForBinding(binding));
      rememberBinding(binding);
      for (const listener of bindingListeners) listener(binding);
      for (const listener of projectListeners) listener(info);
      return binding;
    } finally {
      activationsInFlight -= 1;
    }
  };

  const listRecent = async (): Promise<RecentProjectSummary[]> => {
    const rows = new Map<string, RecentProjectSummary>();
    for (const binding of workspace.openBindings) {
      rows.set(binding.key, {
        rootPath: binding.rootPath,
        displayName: binding.displayName,
        exists: true,
        lastOpenedAt: "",
        kind: "remote",
        gitOriginUrl: binding.gitOriginUrl ?? null,
        remote: {
          targetId: binding.targetId,
          projectId: binding.projectId,
          runtimeName: binding.runtimeName,
          hostname: binding.hostname ?? binding.runtimeName,
          gitOriginUrl: binding.gitOriginUrl ?? null,
          iconDataUrl: binding.iconDataUrl ?? null,
        },
      });
    }
    for (const session of manager.getSnapshot().sessions) {
      for (const project of session.projects) {
        const key = bindingKey(session.targetId, project.id);
        rows.set(key, {
          rootPath: project.rootPath ?? `remote:${project.id}`,
          displayName: project.displayName,
          exists: project.isAvailable,
          lastOpenedAt: project.lastOpenedAt ?? "",
          laneCount: project.laneCount,
          kind: "remote",
          gitOriginUrl: gitOriginUrl(project),
          remote: {
            targetId: session.targetId,
            projectId: project.id,
            runtimeName: session.environment.machineName,
            hostname: session.environment.hostIdentity?.name ?? session.environment.machineName,
            gitOriginUrl: gitOriginUrl(project),
            iconDataUrl: project.iconDataUrl ?? null,
          },
        });
      }
    }
    return [...rows.values()];
  };

  const appOverrides = {
    async getProject() {
      return activeBinding
        ? {
            rootPath: activeBinding.rootPath,
            displayName: activeBinding.displayName,
            baseRef: "main",
          }
        : null;
    },
    async getWindowSession() {
      return {
        windowId: null,
        project: activeBinding
          ? {
              rootPath: activeBinding.rootPath,
              displayName: activeBinding.displayName,
              baseRef: "main",
            }
          : null,
        binding: activeBinding,
        openProjectTabs: [],
        openProjectBindings: workspace.openBindings,
      };
    },
    async setWindowProjectTabs() {
      return { openProjectTabs: [] };
    },
    async setWindowProjectBindings(bindings: OpenProjectBinding[]) {
      const remoteBindings = bindings.filter((entry): entry is RemoteBinding => entry.kind === "remote");
      workspace = {
        ...workspace,
        openBindings: remoteBindings,
        activeBindingKey:
          activeBinding && remoteBindings.some((entry) => entry.key === activeBinding?.key)
            ? activeBinding.key
            : null,
      };
      if (workspace.activeBindingKey == null) activeBinding = null;
      manager.setProtectedTargetId(activeBinding?.targetId ?? null);
      disposeClosedProjectAdapters(remoteBindings);
      persist();
      return { openProjectBindings: remoteBindings };
    },
    onProjectChanged(listener: (project: ProjectInfo | null) => void) {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
    onProjectBindingChanged(listener: (binding: OpenProjectBinding | null) => void) {
      bindingListeners.add(listener);
      return () => bindingListeners.delete(listener);
    },
  };

  const projectOverrides = {
    listRecent,
    async setRecentPinned() {
      return await listRecent();
    },
    async switchToPath(rootPath: string) {
      // A path is not a machine. The same checkout path routinely exists on
      // several machines, and sessions arrive most-recently-used first, so
      // resolving by path alone would hand an already-open tab to whichever
      // machine the user most recently touched — silently moving that tab off
      // its machine. Bindings we already hold win, and they carry the machine.
      const openBinding =
        (activeBinding?.rootPath === rootPath ? activeBinding : null)
        ?? workspace.openBindings.find((entry) => entry.rootPath === rootPath)
        ?? null;
      if (openBinding) {
        await openProject(openBinding.targetId, openBinding.projectId);
        return {
          rootPath: openBinding.rootPath,
          displayName: openBinding.displayName,
          baseRef: "main",
        };
      }
      for (const session of manager.getSnapshot().sessions) {
        const project = session.projects.find((entry) => entry.rootPath === rootPath);
        if (!project) continue;
        await openProject(session.targetId, project.id);
        return projectInfo(project);
      }
      throw new Error("That project is no longer available.");
    },
  };

  const forgetEnvironment = async (targetId: string): Promise<void> => {
    await manager.forgetEnvironment(targetId);
    const removesActiveBinding =
      activeBinding?.targetId === targetId
      || workspace.openBindings.some(
        (entry) => entry.key === workspace.activeBindingKey && entry.targetId === targetId,
      );
    const removesActiveChats =
      workspace.activeSurface === "chats"
      && workspace.selectedChatsTargetId === targetId;
    workspace = {
      ...workspace,
      openBindings: workspace.openBindings.filter((entry) => entry.targetId !== targetId),
      activeBindingKey: removesActiveBinding ? null : workspace.activeBindingKey,
      activeSurface: removesActiveBinding || removesActiveChats ? "hub" : workspace.activeSurface,
      selectedHubTargetId:
        workspace.selectedHubTargetId === targetId ? null : workspace.selectedHubTargetId,
      selectedChatsTargetId:
        workspace.selectedChatsTargetId === targetId ? null : workspace.selectedChatsTargetId,
    };
    if (removesActiveBinding) {
      activeBinding = null;
      for (const listener of bindingListeners) listener(null);
      for (const listener of projectListeners) listener(null);
    }
    if (removesActiveBinding || removesActiveChats) {
      manager.setProtectedTargetId(null);
    }
    disposeClosedProjectAdapters(workspace.openBindings);
    persist();
  };

  const remoteRuntimeOverrides = {
    async listTargets() {
      return getConnectionSnapshot().connections.map((entry) => entry.target);
    },
    async getConnectionSnapshot() {
      return getConnectionSnapshot();
    },
    onConnectionSnapshotChanged(listener: (snapshot: RemoteRuntimeConnectionSnapshot) => void) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    async connect(targetId: string) {
      const session = await manager.connectEnvironment(targetId);
      const connection = getConnectionSnapshot().connections.find((entry) => entry.target.id === targetId);
      if (!connection) throw new Error("The machine connection disappeared.");
      return {
        target: connection.target,
        arch: "web",
        version: null,
        route: connection.route,
        capabilities: connection.capabilities,
        projects: connection.projects,
      };
    },
    async listProjects(targetId: string) {
      await manager.connectEnvironment(targetId);
      return getConnectionSnapshot().connections.find((entry) => entry.target.id === targetId)?.projects ?? [];
    },
    openProject,
    async disconnect(targetId: string) {
      await manager.park(targetId);
      return { disconnected: true };
    },
    async removeTarget(targetId: string) {
      await forgetEnvironment(targetId);
      return { removed: true };
    },
  };

  /**
   * Members the federation answers itself rather than forwarding to a machine's
   * adapter, consulted by `dynamicMember` before it reads the adapter.
   *
   * Everything NOT listed here must still resolve against the adapter that is
   * actually displayed. An earlier version spread the fallback adapter into
   * these objects, which froze the rest onto `fallbackClient` — the manager's
   * primaryClient, handed to the first machine that connects — so every
   * non-overridden call (`project.openRepo`, which switches a project, among
   * them) executed against that machine no matter which tab was in front.
   */
  const OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    app: appOverrides,
    project: projectOverrides,
    remoteRuntime: remoteRuntimeOverrides,
  };

  const bindingFromArgs = (args: unknown[]): RemoteBinding | null => {
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const candidate = args[index];
      if (!candidate || typeof candidate !== "object") continue;
      const binding = candidate as Partial<RemoteBinding>;
      if (
        binding.kind === "remote"
        && typeof binding.key === "string"
        && typeof binding.targetId === "string"
        && typeof binding.projectId === "string"
      ) {
        return binding as RemoteBinding;
      }
    }
    return null;
  };

  const namespaceProxyCache = new Map<string, unknown>();
  const dynamicMember = (path: PropertyKey[]): unknown => {
    // Overrides win over the displayed adapter, and are never cached as proxies
    // — they are already the final value.
    if (path.length === 2) {
      const overrides = OVERRIDES[String(path[0])];
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, path[1] as string)) {
        return overrides[path[1] as string];
      }
    }
    const cacheKey = path.map(String).join(".");
    const cached = namespaceProxyCache.get(cacheKey);
    if (cached) return cached;
    // An override namespace must resolve to a namespace proxy even if the
    // displayed adapter happens not to expose it — that is how its overridden
    // members stay reachable.
    const isOverrideNamespace = path.length === 1 && OVERRIDES[String(path[0])] != null;
    const current = isOverrideNamespace ? {} : readPath(currentAdapter, path).value;
    if (typeof current === "function") {
      const callDynamic = (...args: unknown[]) => {
        const pinned = bindingFromArgs(args);
        const { parent, value } = readPath(
          pinned ? adapterForBinding(pinned) : currentAdapter,
          path,
        );
        if (typeof value !== "function") return value;
        // Some adapter functions are themselves proxies so nested missing APIs
        // can keep resolving. Reflect.apply invokes the callable directly
        // without reading its potentially proxied `.apply` property.
        const result = Reflect.apply(value, parent, args);
        // A pinned call belongs to its binding for life. An unpinned one that
        // handed back an unsubscribe is a subscription on the *displayed*
        // project, so it has to follow the display across tab switches.
        if (pinned || !isSubscriptionMember(path) || typeof result !== "function") {
          return result;
        }
        return registerDurableSubscription({
          path,
          args,
          detach: result as () => void,
        });
      };
      const dynamicFunction = new Proxy(callDynamic, {
        get(_target, property) {
          return dynamicMember([...path, property]);
        },
      });
      namespaceProxyCache.set(cacheKey, dynamicFunction);
      return dynamicFunction;
    }
    if (current && typeof current === "object") {
      const dynamicNamespace = new Proxy({}, {
        get(_target, property) {
          return dynamicMember([...path, property]);
        },
      });
      namespaceProxyCache.set(cacheKey, dynamicNamespace);
      return dynamicNamespace;
    }
    return current;
  };

  const surface = new Proxy({} as Window["ade"], {
    get: (_target, property) => dynamicMember([property]),
  });

  /**
   * Re-point `currentAdapter` at the surface the workspace says is displayed.
   *
   * A machine's client is replaced on every reconnect, which disposes its
   * adapters and parks the display on `fallbackAdapter`. Nothing else moved it
   * back: the host-driven rebind below only fires when the *project* changes,
   * so a plain reconnect left the tab wired to `fallbackClient` — the first
   * machine that ever connected — for the rest of the session, with every
   * durable subscription re-attached to that machine's socket.
   */
  const restoreCurrentAdapterForDisplayedSurface = (): void => {
    try {
      if (workspace.activeSurface === "chats") {
        const targetId = workspace.selectedChatsTargetId;
        if (targetId && manager.getClient(targetId)) setCurrentAdapter(adapterForChats(targetId));
        return;
      }
      if (workspace.activeSurface !== "project" || !activeBinding) return;
      if (!manager.getClient(activeBinding.targetId)) return;
      setCurrentAdapter(adapterForBinding(activeBinding));
    } catch {
      // The machine went away between the lookup and the bind; the next
      // snapshot retries.
    }
  };

  manager.setProtectedTargetId(activeBinding?.targetId ?? null);
  const invalidationDispose = manager.subscribeEnvironmentInvalidation(
    async ({ targetId }) => {
      await forgetEnvironment(targetId);
    },
  );
  managerDispose = manager.subscribe((snapshot) => {
    for (const [key, entry] of adaptersByBinding) {
      if (manager.getClient(entry.targetId) === entry.client) continue;
      entry.adapter.dispose();
      adapters.delete(entry.adapter);
      adaptersByBinding.delete(key);
      if (currentAdapter === entry.adapter) setCurrentAdapter(fallbackAdapter);
    }
    // Covers both the reconnect that just replaced a client above and a later
    // snapshot in which a machine we were parked off of comes back.
    if (currentAdapter === fallbackAdapter) restoreCurrentAdapterForDisplayedSurface();
    const connectionSnapshot = getConnectionSnapshot();
    for (const listener of connectionListeners) listener(connectionSnapshot);
    if (workspace.activeSurface !== "project" || !activeBinding) return;
    // Mid-activation the displayed binding is already stale: the user asked for
    // another tab and `openProject` has not committed it yet. Rebinding here
    // would write the outgoing tab back over the incoming one.
    if (activationsInFlight > 0) return;
    const displayedBinding = activeBinding;
    // Look up only the displayed machine's own session. A host reports its own
    // active project; following any other machine's report would move a tab off
    // the machine it is bound to, which no host event is allowed to do.
    const session = snapshot.sessions.find(
      (entry) => entry.targetId === displayedBinding.targetId,
    );
    const nextProjectId = session?.activeProjectId;
    if (!session || !nextProjectId || nextProjectId === displayedBinding.projectId) return;
    const project = session.projects.find((entry) => entry.id === nextProjectId);
    if (!project || !manager.getClient(session.targetId)) return;
    const info = projectInfo(project);
    const binding: RemoteBinding = {
      kind: "remote",
      key: bindingKey(session.targetId, project.id),
      targetId: session.targetId,
      runtimeName: session.environment.machineName,
      hostname: session.environment.hostIdentity?.name,
      projectId: project.id,
      rootPath: info.rootPath,
      displayName: info.displayName,
      gitOriginUrl: gitOriginUrl(project),
      iconDataUrl: project.iconDataUrl ?? null,
    };
    setCurrentAdapter(adapterForBinding(binding));
    rememberBinding(binding);
    for (const listener of bindingListeners) listener(binding);
    for (const listener of projectListeners) listener(info);
  });

  return {
    ade: surface,
    getOpenBindings: () => workspace.openBindings.slice(),
    getActiveBinding: () => activeBinding,
    getDisplayedTargetId: () => {
      if (workspace.activeSurface === "hub") return null;
      for (const entry of adaptersByBinding.values()) {
        if (entry.adapter === currentAdapter) return entry.targetId;
      }
      return null;
    },
    getSelectedHubTargetId: () => workspace.selectedHubTargetId,
    setSelectedHubTargetId(targetId) {
      workspace = { ...workspace, selectedHubTargetId: targetId };
      persist();
    },
    activateHub() {
      setCurrentAdapter(fallbackAdapter);
      workspace = { ...workspace, activeSurface: "hub" };
      persist();
    },
    getSelectedChatsTargetId: () => workspace.selectedChatsTargetId,
    async openProject(targetId, projectId) {
      return await openProject(targetId, projectId);
    },
    async activateChats(targetId) {
      await manager.connectEnvironment(targetId);
      setCurrentAdapter(adapterForChats(targetId));
      workspace = {
        ...workspace,
        selectedChatsTargetId: targetId,
        activeBindingKey: null,
        activeSurface: "chats",
      };
      manager.setProtectedTargetId(targetId);
      persist();
      activeBinding = null;
      for (const listener of bindingListeners) listener(null);
      for (const listener of projectListeners) listener(null);
    },
    forgetEnvironment,
    async restore() {
      if (workspace.activeSurface === "chats" && workspace.selectedChatsTargetId) {
        try {
          await manager.connectEnvironment(workspace.selectedChatsTargetId);
          setCurrentAdapter(adapterForChats(workspace.selectedChatsTargetId));
          activeBinding = null;
          return "chats";
        } catch {
          workspace = { ...workspace, activeSurface: "hub", selectedChatsTargetId: null };
          manager.setProtectedTargetId(activeBinding?.targetId ?? null);
          persist();
          return null;
        }
      }
      if (workspace.activeSurface !== "project") return null;
      const binding = activeBinding;
      if (!binding) return null;
      try {
        await openProject(binding.targetId, binding.projectId);
        return "project";
      } catch {
        activeBinding = null;
        manager.setProtectedTargetId(null);
        workspace = { ...workspace, activeBindingKey: null, activeSurface: "hub" };
        persist();
        return null;
      }
    },
    subscribeActiveAdapter(listener) {
      activeAdapterListeners.add(listener);
      return () => activeAdapterListeners.delete(listener);
    },
    dispose() {
      invalidationDispose();
      managerDispose();
      manager.setProtectedTargetId(null);
      for (const entry of durableSubscriptions) detachDurableSubscription(entry);
      durableSubscriptions.clear();
      for (const adapter of adapters) adapter.dispose();
      projectListeners.clear();
      bindingListeners.clear();
      connectionListeners.clear();
      activeAdapterListeners.clear();
    },
  };
}
