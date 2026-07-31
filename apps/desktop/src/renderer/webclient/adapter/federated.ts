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
  rootPath: string | null;
  displayName: string;
  defaultBaseRef?: string | null;
}): ProjectInfo {
  return {
    rootPath: project.rootPath ?? "",
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
  getSelectedHubTargetId(): string | null;
  setSelectedHubTargetId(targetId: string | null): void;
  activateHub(): void;
  getSelectedChatsTargetId(): string | null;
  openProject(targetId: string, projectId: string): Promise<RemoteBinding>;
  activateChats(targetId: string): Promise<void>;
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

  const setCurrentAdapter = (adapter: AdeWebAdapter) => {
    if (currentAdapter === adapter) return;
    currentAdapter = adapter;
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
    adaptersByBinding.set(binding.key, { targetId: binding.targetId, client, adapter });
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
    adaptersByBinding.set(key, { targetId, client, adapter });
    adapters.add(adapter);
    return adapter;
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
    persist();
  };

  const openProject = async (targetId: string, projectId: string): Promise<RemoteBinding> => {
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
    setCurrentAdapter(adapterForBinding(binding));
    rememberBinding(binding);
    for (const listener of bindingListeners) listener(binding);
    for (const listener of projectListeners) listener(info);
    return binding;
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

  const specialApp = {
    ...fallbackAdapter.ade.app,
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

  const specialProject = {
    ...fallbackAdapter.ade.project,
    listRecent,
    async setRecentPinned() {
      return await listRecent();
    },
    async switchToPath(rootPath: string) {
      for (const session of manager.getSnapshot().sessions) {
        const project = session.projects.find((entry) => entry.rootPath === rootPath);
        if (!project) continue;
        await openProject(session.targetId, project.id);
        return projectInfo(project);
      }
      const binding = workspace.openBindings.find((entry) => entry.rootPath === rootPath);
      if (!binding) throw new Error("That project is no longer available.");
      await openProject(binding.targetId, binding.projectId);
      return {
        rootPath: binding.rootPath,
        displayName: binding.displayName,
        baseRef: "main",
      };
    },
  };

  const specialRemoteRuntime = {
    ...fallbackAdapter.ade.remoteRuntime,
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
      await manager.forgetEnvironment(targetId);
      workspace = {
        ...workspace,
        openBindings: workspace.openBindings.filter((entry) => entry.targetId !== targetId),
        activeBindingKey: activeBinding?.targetId === targetId ? null : workspace.activeBindingKey,
      };
      if (activeBinding?.targetId === targetId) activeBinding = null;
      persist();
      return { removed: true };
    },
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

  const adapterForCall = (args: unknown[]): AdeWebAdapter => {
    const binding = bindingFromArgs(args);
    if (!binding) return currentAdapter;
    return adapterForBinding(binding);
  };

  const readPath = (
    adapter: AdeWebAdapter,
    path: PropertyKey[],
  ): { parent: unknown; value: unknown } => {
    let parent: unknown = adapter.ade;
    let value: unknown = adapter.ade;
    for (const key of path) {
      parent = value;
      value = (value as Record<PropertyKey, unknown> | null | undefined)?.[key];
    }
    return { parent, value };
  };

  const namespaceProxyCache = new Map<string, unknown>();
  const dynamicMember = (path: PropertyKey[]): unknown => {
    const cacheKey = path.map(String).join(".");
    const cached = namespaceProxyCache.get(cacheKey);
    if (cached) return cached;
    const current = readPath(currentAdapter, path).value;
    if (typeof current === "function") {
      const callDynamic = (...args: unknown[]) => {
        const { parent, value } = readPath(adapterForCall(args), path);
        if (typeof value !== "function") return value;
        // Some adapter functions are themselves proxies so nested missing APIs
        // can keep resolving. Reflect.apply invokes the callable directly
        // without reading its potentially proxied `.apply` property.
        return Reflect.apply(value, parent, args);
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
    get(_target, property) {
      if (property === "app") return specialApp;
      if (property === "project") return specialProject;
      if (property === "remoteRuntime") return specialRemoteRuntime;
      return dynamicMember([property]);
    },
  });

  managerDispose = manager.subscribe((snapshot) => {
    for (const [key, entry] of adaptersByBinding) {
      if (manager.getClient(entry.targetId) === entry.client) continue;
      entry.adapter.dispose();
      adapters.delete(entry.adapter);
      adaptersByBinding.delete(key);
      if (currentAdapter === entry.adapter) setCurrentAdapter(fallbackAdapter);
    }
    const connectionSnapshot = getConnectionSnapshot();
    for (const listener of connectionListeners) listener(connectionSnapshot);
    if (workspace.activeSurface !== "project" || !activeBinding) return;
    const session = snapshot.sessions.find(
      (entry) => entry.targetId === activeBinding?.targetId,
    );
    const nextProjectId = session?.activeProjectId;
    if (!session || !nextProjectId || nextProjectId === activeBinding.projectId) return;
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
    getSelectedHubTargetId: () => workspace.selectedHubTargetId,
    setSelectedHubTargetId(targetId) {
      workspace = { ...workspace, selectedHubTargetId: targetId };
      persist();
    },
    activateHub() {
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
      persist();
      activeBinding = null;
      for (const listener of bindingListeners) listener(null);
      for (const listener of projectListeners) listener(null);
    },
    async restore() {
      if (workspace.activeSurface === "chats" && workspace.selectedChatsTargetId) {
        try {
          await manager.connectEnvironment(workspace.selectedChatsTargetId);
          setCurrentAdapter(adapterForChats(workspace.selectedChatsTargetId));
          activeBinding = null;
          return "chats";
        } catch {
          workspace = { ...workspace, activeSurface: "hub", selectedChatsTargetId: null };
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
      managerDispose();
      for (const adapter of adapters) adapter.dispose();
      projectListeners.clear();
      bindingListeners.clear();
      connectionListeners.clear();
      activeAdapterListeners.clear();
    },
  };
}
