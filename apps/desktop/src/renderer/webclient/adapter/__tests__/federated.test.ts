/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { BrowserAccountClient } from "../../account/client";
import type { AdeSyncClient } from "../../sync";
import type { WebMachineSessionManager } from "../../workspace/WebMachineSessionManager";
import { createFederatedWebAdapter } from "../federated";

const adapters = vi.hoisted(() => new Map<object, {
  ade: Window["ade"];
  bindProject: ReturnType<typeof vi.fn>;
  replaceProject: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>());

vi.mock("../index", () => ({
  createAdeWebAdapter: (client: object) => adapters.get(client),
}));

function fakeAdapter(label: string) {
  const createPromptStash = vi.fn(async () => ({ id: label }));
  const onAgentChatEvent = vi.fn(() => () => {});
  // A realistic subscription: it delivers to live listeners and stops when the
  // unsubscribe it handed back is called.
  const laneListeners = new Set<(event: unknown) => void>();
  const laneDetach = vi.fn();
  const onLanesChanged = vi.fn((listener: (event: unknown) => void) => {
    laneListeners.add(listener);
    return () => {
      laneDetach();
      laneListeners.delete(listener);
    };
  });
  const navigationListeners = new Set<(request: unknown) => void>();
  const onNavigate = vi.fn((listener: (request: unknown) => void) => {
    navigationListeners.add(listener);
    return () => navigationListeners.delete(listener);
  });
  const adapter = {
    ade: {
      app: { onNavigate },
      project: {},
      remoteRuntime: {},
      lanes: { onChanged: onLanesChanged },
      agentChat: {
        onEvent: onAgentChatEvent,
        promptStashes: {
          create: createPromptStash,
          delete: vi.fn(async () => true),
          list: vi.fn(async () => []),
        },
      },
    } as unknown as Window["ade"],
    bindProject: vi.fn(),
    replaceProject: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    adapter,
    createPromptStash,
    onAgentChatEvent,
    onNavigate,
    onLanesChanged,
    laneDetach,
    laneListenerCount: () => laneListeners.size,
    emitLaneChange(event: unknown) {
      for (const listener of laneListeners) listener(event);
    },
    emitNavigate(request: unknown) {
      for (const listener of navigationListeners) listener(request);
    },
  };
}

function binding(targetId: string): Extract<OpenProjectBinding, { kind: "remote" }> {
  return {
    kind: "remote",
    key: `remote:${targetId}:project-${targetId}`,
    targetId,
    runtimeName: targetId,
    projectId: `project-${targetId}`,
    rootPath: `/repos/${targetId}`,
    displayName: targetId,
  };
}

function managerFixture() {
  const fallbackClient = {} as AdeSyncClient;
  const clientA = {} as AdeSyncClient;
  const clientB = {} as AdeSyncClient;
  const fallback = fakeAdapter("fallback");
  const targetA = fakeAdapter("machine-a");
  const targetB = fakeAdapter("machine-b");
  adapters.set(fallbackClient, fallback.adapter);
  adapters.set(clientA, targetA.adapter);
  adapters.set(clientB, targetB.adapter);
  const clients = new Map([
    ["machine-a", clientA],
    ["machine-b", clientB],
  ]);
  const sessions = ["machine-a", "machine-b"].map((targetId) => ({
    targetId,
    environment: {
      envId: targetId,
      machineName: targetId,
      addressCandidates: [],
    },
    state: "live" as const,
    projects: [{
      id: `project-${targetId}`,
      displayName: targetId,
      rootPath: `/repos/${targetId}` as string | null,
      defaultBaseRef: "main",
      lastOpenedAt: null,
      laneCount: 0,
      isAvailable: true,
      isCached: true,
      isOpen: true,
    }],
    activeProjectId: `project-${targetId}`,
  }));
  const listeners = new Set<(snapshot: { sessions: typeof sessions }) => void>();
  const invalidationListeners = new Set<(event: {
    targetId: string;
    reason: "auth_failed";
  }) => void | Promise<void>>();
  const manager = {
    subscribe: vi.fn((listener: (snapshot: { sessions: typeof sessions }) => void) => {
      listeners.add(listener);
      listener({ sessions });
      return () => listeners.delete(listener);
    }),
    getConnectionSnapshot: vi.fn(() => ({
      connections: [],
      connectedCount: 0,
      updatedAt: 0,
    })),
    getClient: vi.fn((targetId: string) => clients.get(targetId) ?? null),
    getCatalog: vi.fn((targetId: string) => (
      sessions.find((entry) => entry.targetId === targetId)?.projects ?? []
    )),
    getSnapshot: vi.fn(() => ({ sessions })),
    getSession: vi.fn((targetId: string) => sessions.find((entry) => entry.targetId === targetId) ?? null),
    connectEnvironment: vi.fn(async (targetId: string) => (
      sessions.find((entry) => entry.targetId === targetId)
    )),
    openProject: vi.fn(async (targetId: string, projectId: string) => {
      const session = sessions.find((entry) => entry.targetId === targetId)!;
      const project = session.projects.find((entry) => entry.id === projectId);
      if (!project) throw new Error("Project not found");
      // The host opens the project, so its session reports it as active and
      // broadcasts a snapshot — exactly what the real manager does.
      session.activeProjectId = projectId;
      for (const listener of listeners) listener({ sessions });
      return { session, project };
    }),
    park: vi.fn(async () => undefined),
    forgetEnvironment: vi.fn(async () => undefined),
    setProtectedTargetId: vi.fn(),
    subscribeEnvironmentInvalidation: vi.fn((listener: (event: {
      targetId: string;
      reason: "auth_failed";
    }) => void | Promise<void>) => {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    }),
    listEnvironments: vi.fn(() => []),
  } as unknown as WebMachineSessionManager;
  return {
    manager,
    fallbackClient,
    fallback,
    clientA,
    targetA,
    targetB,
    sessions,
    emitSnapshot() {
      for (const listener of listeners) listener({ sessions });
    },
    /**
     * What a reconnect looks like from the federated adapter's side: the
     * manager hands out a brand-new client object for the same machine, so
     * every adapter built on the old one is stale. Returns the fresh machine's
     * fake adapter so a test can assert what re-attached to it.
     */
    reconnect(targetId: string) {
      const client = {} as AdeSyncClient;
      const replacement = fakeAdapter(`${targetId}-reconnected`);
      adapters.set(client, replacement.adapter);
      clients.set(targetId, client);
      for (const listener of listeners) listener({ sessions });
      return replacement;
    },
    /** Drops a machine's client entirely, as an offline machine would. */
    disconnect(targetId: string) {
      clients.delete(targetId);
      for (const listener of listeners) listener({ sessions });
    },
    async emitInvalidation(targetId: string) {
      await Promise.all([...invalidationListeners].map((listener) => listener({
        targetId,
        reason: "auth_failed",
      })));
    },
  };
}

const accountClient = {} as BrowserAccountClient;

afterEach(() => {
  localStorage.clear();
  adapters.clear();
});

describe("createFederatedWebAdapter", () => {
  it("routes nested pinned operations to their bound machine after another tab activates", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "pinned-routing",
      fallbackClient: fixture.fallbackClient,
    });
    const bindingA = await federated.openProject("machine-a", "project-machine-a");
    await federated.openProject("machine-b", "project-machine-b");

    await federated.ade.agentChat.promptStashes.create(
      { text: "keep this on A", attachments: [] },
      bindingA,
    );

    expect(fixture.targetA.createPromptStash).toHaveBeenCalledOnce();
    expect(fixture.targetB.createPromptStash).not.toHaveBeenCalled();
  });

  it("keeps delayed pinned operations bound to their project on the same machine", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "same-machine-routing",
      fallbackClient: fixture.fallbackClient,
    });
    const bindingA = await federated.openProject("machine-a", "project-machine-a");
    fixture.sessions[0].projects.push({
      ...fixture.sessions[0].projects[0],
      id: "project-machine-a-next",
      displayName: "Next project",
      rootPath: "/repos/machine-a-next",
    });
    const nextProjectAdapter = fakeAdapter("machine-a-next");
    adapters.set(fixture.clientA, nextProjectAdapter.adapter);
    await federated.openProject("machine-a", "project-machine-a-next");

    await federated.ade.agentChat.promptStashes.create(
      { text: "keep this on the first project", attachments: [] },
      bindingA,
    );

    expect(fixture.targetA.createPromptStash).toHaveBeenCalledOnce();
    expect(nextProjectAdapter.createPromptStash).not.toHaveBeenCalled();
  });

  it("finds a pinned binding before trailing call options", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "second-last-binding",
      fallbackClient: fixture.fallbackClient,
    });
    const bindingA = await federated.openProject("machine-a", "project-machine-a");
    await federated.openProject("machine-b", "project-machine-b");
    const listener = vi.fn();

    (federated.ade.agentChat.onEvent as unknown as (
      listener: () => void,
      binding: OpenProjectBinding,
      options: { forcePinned: boolean },
    ) => () => void)(listener, bindingA, { forcePinned: true });

    expect(fixture.targetA.onAgentChatEvent).toHaveBeenCalledWith(
      listener,
      bindingA,
      { forcePinned: true },
    );
    expect(fixture.targetB.onAgentChatEvent).not.toHaveBeenCalled();
  });

  it("invokes proxied subscription functions without resolving their apply member", () => {
    const fixture = managerFixture();
    const unsubscribe = vi.fn();
    const onUpdate = new Proxy(vi.fn(() => unsubscribe), {
      get(target, property, receiver) {
        if (property === "apply") return vi.fn(async () => null);
        return Reflect.get(target, property, receiver);
      },
    });
    fixture.targetA.adapter.ade.usage = {
      onUpdate,
    } as unknown as Window["ade"]["usage"];
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "proxied-subscription",
      fallbackClient: fixture.fallbackClient,
    });

    return federated.openProject("machine-a", "project-machine-a").then(() => {
      const result = federated.ade.usage.onUpdate(vi.fn());
      expect(onUpdate).toHaveBeenCalledOnce();
      // Unpinned subscriptions come back wrapped so they can follow the
      // displayed adapter, so this is the adapter's own unsubscribe reached
      // through that wrapper rather than the identical function object.
      expect(typeof result).toBe("function");
      (result as unknown as () => void)();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  it("forwards navigation only from the displayed adapter across surface switches", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "active-navigation",
      fallbackClient: fixture.fallbackClient,
    });
    const listener = vi.fn();
    const dispose = federated.ade.app.onNavigate!(listener);

    await federated.openProject("machine-a", "project-machine-a");
    fixture.targetA.emitNavigate({ path: "/lanes" });
    federated.activateHub();
    fixture.targetA.emitNavigate({ path: "/files" });
    fixture.fallback.emitNavigate({ path: "/hub" });
    await federated.openProject("machine-b", "project-machine-b");
    fixture.fallback.emitNavigate({ path: "/settings" });
    fixture.targetB.emitNavigate({ path: "/work" });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, { path: "/lanes" });
    expect(listener).toHaveBeenNthCalledWith(2, { path: "/hub" });
    expect(listener).toHaveBeenNthCalledWith(3, { path: "/work" });
    expect(fixture.fallback.onNavigate).toHaveBeenCalledTimes(2);
    expect(fixture.targetA.onNavigate).toHaveBeenCalledOnce();
    expect(fixture.targetB.onNavigate).toHaveBeenCalledOnce();

    dispose();
    fixture.targetB.emitNavigate({ path: "/history" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("reports lifecycle ownership from the displayed project or Chats adapter", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "displayed-target",
      fallbackClient: fixture.fallbackClient,
    });

    expect(federated.getDisplayedTargetId()).toBeNull();
    await federated.openProject("machine-a", "project-machine-a");
    expect(federated.getDisplayedTargetId()).toBe("machine-a");
    federated.activateHub();
    expect(federated.getDisplayedTargetId()).toBeNull();
    await federated.activateChats("machine-b");
    expect(federated.getDisplayedTargetId()).toBe("machine-b");
  });

  it("restores machine-scoped Chats without reopening the previous project", async () => {
    const fixture = managerFixture();
    const first = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "chats-restore",
      fallbackClient: fixture.fallbackClient,
    });
    await first.openProject("machine-a", "project-machine-a");
    await first.activateChats("machine-b");
    first.dispose();

    const restored = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "chats-restore",
      fallbackClient: fixture.fallbackClient,
    });

    await expect(restored.restore()).resolves.toBe("chats");
    expect(fixture.targetB.adapter.bindProject).toHaveBeenLastCalledWith(null);
    expect(restored.getActiveBinding()).toBeNull();
  });

  it("keeps the Hub as the foreground surface across reloads", async () => {
    const fixture = managerFixture();
    const first = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "hub-restore",
      fallbackClient: fixture.fallbackClient,
    });
    await first.openProject("machine-a", "project-machine-a");
    first.activateHub();
    first.dispose();

    const restored = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "hub-restore",
      fallbackClient: fixture.fallbackClient,
    });

    await expect(restored.restore()).resolves.toBeNull();
  });

  it("rebinds the active surface when its host changes project", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "host-boundary",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");
    const session = fixture.sessions[0];
    session.projects.push({
      ...session.projects[0],
      id: "project-machine-a-next",
      displayName: "Next project",
      rootPath: "/repos/machine-a-next",
    });
    session.activeProjectId = "project-machine-a-next";

    fixture.emitSnapshot();

    expect(fixture.targetA.adapter.bindProject).toHaveBeenLastCalledWith(
      {
        rootPath: "/repos/machine-a-next",
        displayName: "Next project",
        baseRef: "main",
      },
      "project-machine-a-next",
    );
    expect(federated.getActiveBinding()?.projectId).toBe("project-machine-a-next");
  });

  it("uses a stable remote identity when a project has no root path", async () => {
    const fixture = managerFixture();
    fixture.sessions[0].projects[0].rootPath = null;
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "rootless-project",
      fallbackClient: fixture.fallbackClient,
    });

    const opened = await federated.openProject("machine-a", "project-machine-a");

    expect(opened.rootPath).toBe("remote:project-machine-a");
    expect(fixture.targetA.adapter.bindProject).toHaveBeenLastCalledWith(
      {
        rootPath: "remote:project-machine-a",
        displayName: "machine-a",
        baseRef: "main",
      },
      "project-machine-a",
    );
  });

  it("disposes project adapters after their persisted binding closes", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "closed-binding-disposal",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");
    const bindingB = await federated.openProject("machine-b", "project-machine-b");

    await federated.ade.app.setWindowProjectBindings!([bindingB]);

    expect(fixture.targetA.adapter.dispose).toHaveBeenCalledOnce();
    expect(fixture.targetB.adapter.dispose).not.toHaveBeenCalled();
    expect(federated.getOpenBindings()).toEqual([bindingB]);

    federated.dispose();
    expect(fixture.targetA.adapter.dispose).toHaveBeenCalledOnce();
    expect(fixture.targetB.adapter.dispose).toHaveBeenCalledOnce();
  });

  it("forgets machine bindings and persists the Hub as the active surface", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "forgotten-machine",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");
    federated.setSelectedHubTargetId("machine-a");
    const bindingListener = vi.fn();
    federated.ade.app.onProjectBindingChanged!(bindingListener);

    await federated.forgetEnvironment("machine-a");

    expect(fixture.manager.forgetEnvironment).toHaveBeenCalledWith("machine-a");
    expect(federated.getOpenBindings()).toEqual([]);
    expect(federated.getActiveBinding()).toBeNull();
    expect(federated.getSelectedHubTargetId()).toBeNull();
    expect(bindingListener).toHaveBeenLastCalledWith(null);
    expect(fixture.targetA.adapter.dispose).toHaveBeenCalledOnce();

    const persisted = JSON.parse(
      localStorage.getItem("ade-web:workspace:v1:forgotten-machine") ?? "null",
    );
    expect(persisted).toMatchObject({
      openBindings: [],
      activeBindingKey: null,
      activeSurface: "hub",
      selectedHubTargetId: null,
    });

    federated.dispose();
    const restored = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "forgotten-machine",
      fallbackClient: fixture.fallbackClient,
    });
    await expect(restored.restore()).resolves.toBeNull();
    expect(restored.getOpenBindings()).toEqual([]);
  });

  it("routes authentication invalidation through federated binding cleanup", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "auth-invalidated-machine",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");

    await fixture.emitInvalidation("machine-a");

    expect(fixture.manager.forgetEnvironment).toHaveBeenCalledWith("machine-a");
    expect(federated.getOpenBindings()).toEqual([]);
    expect(federated.getActiveBinding()).toBeNull();
    expect(fixture.targetA.adapter.dispose).toHaveBeenCalledOnce();
  });

  it("leaves the other tab's machine binding untouched when a tab is activated", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "cross-tab-binding",
      fallbackClient: fixture.fallbackClient,
    });
    const bindingA = await federated.openProject("machine-a", "project-machine-a");
    const bindingB = await federated.openProject("machine-b", "project-machine-b");
    fixture.emitSnapshot();
    await federated.openProject("machine-a", "project-machine-a");
    fixture.emitSnapshot();

    expect(federated.getOpenBindings()).toEqual([bindingA, bindingB]);
    expect(federated.getActiveBinding()).toEqual(bindingA);
    expect(
      JSON.parse(localStorage.getItem("ade-web:workspace:v1:cross-tab-binding") ?? "null"),
    ).toMatchObject({
      openBindings: [
        { key: bindingA.key, targetId: "machine-a", projectId: "project-machine-a" },
        { key: bindingB.key, targetId: "machine-b", projectId: "project-machine-b" },
      ],
      activeBindingKey: bindingA.key,
    });
  });

  it("resolves a shared checkout path to the machine its open tab is bound to", async () => {
    const fixture = managerFixture();
    // The same path exists on both machines, and machine-b is the most recently
    // used one, so a path-only lookup would hand tab A to machine-b.
    fixture.sessions[1].projects.push({
      ...fixture.sessions[1].projects[0],
      id: "project-machine-b-clone",
      displayName: "Clone",
      rootPath: "/repos/machine-a",
    });
    fixture.sessions.reverse();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "path-machine-pinning",
      fallbackClient: fixture.fallbackClient,
    });
    const bindingA = await federated.openProject("machine-a", "project-machine-a");
    await federated.openProject("machine-b", "project-machine-b");

    await federated.ade.project.switchToPath("/repos/machine-a");

    expect(fixture.manager.openProject).toHaveBeenLastCalledWith(
      "machine-a",
      "project-machine-a",
    );
    expect(federated.getActiveBinding()).toEqual(bindingA);
  });

  it("ignores a host project report that lands while another tab is activating", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "activation-race",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");
    // Machine A's host moves on to another project just as the user activates
    // the tab living on machine B.
    fixture.sessions[0].projects.push({
      ...fixture.sessions[0].projects[0],
      id: "project-machine-a-next",
      displayName: "Next project",
      rootPath: "/repos/machine-a-next",
    });
    (fixture.manager.openProject as unknown as {
      mockImplementationOnce: (impl: (targetId: string, projectId: string) => Promise<unknown>) => void;
    }).mockImplementationOnce(async (targetId: string, projectId: string) => {
      fixture.sessions[0].activeProjectId = "project-machine-a-next";
      fixture.emitSnapshot();
      const session = fixture.sessions.find((entry) => entry.targetId === targetId)!;
      session.activeProjectId = projectId;
      return { session, project: session.projects.find((entry) => entry.id === projectId) };
    });

    const bindingB = await federated.openProject("machine-b", "project-machine-b");

    expect(federated.getActiveBinding()).toEqual(bindingB);
    expect(federated.getOpenBindings().map((entry) => entry.key)).toEqual([
      "remote:machine-a:project-machine-a",
      bindingB.key,
    ]);
  });

  it("routes non-overridden project members to the displayed machine, not the fallback", async () => {
    const fixture = managerFixture();
    const fallbackOpenRepo = vi.fn(async () => null);
    const openRepoA = vi.fn(async () => null);
    const openRepoB = vi.fn(async () => null);
    (fixture.fallback.adapter.ade.project as Record<string, unknown>).openRepo = fallbackOpenRepo;
    (fixture.targetA.adapter.ade.project as Record<string, unknown>).openRepo = openRepoA;
    (fixture.targetB.adapter.ade.project as Record<string, unknown>).openRepo = openRepoB;
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "namespace-routing",
      fallbackClient: fixture.fallbackClient,
    });

    await federated.openProject("machine-a", "project-machine-a");
    await federated.openProject("machine-b", "project-machine-b");
    await (federated.ade.project as unknown as {
      openRepo: (args: { rootPath: string }) => Promise<unknown>;
    }).openRepo({ rootPath: "/repos/machine-b" });

    // The fallback adapter shares `fallbackClient` with the first machine that
    // connects, so a fallback-routed project switch lands on that machine.
    expect(fallbackOpenRepo).not.toHaveBeenCalled();
    expect(openRepoA).not.toHaveBeenCalled();
    expect(openRepoB).toHaveBeenCalledOnce();
  });

  it("sends no command to the machine being left when another tab is activated", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "no-departing-command",
      fallbackClient: fixture.fallbackClient,
    });
    const bindingA = await federated.openProject("machine-a", "project-machine-a");
    (fixture.manager.openProject as unknown as { mockClear: () => void }).mockClear();

    await federated.openProject("machine-b", "project-machine-b");
    fixture.emitSnapshot();

    expect(fixture.manager.openProject).toHaveBeenCalledOnce();
    expect(fixture.manager.openProject).toHaveBeenCalledWith(
      "machine-b",
      "project-machine-b",
    );
    expect(fixture.sessions[0].activeProjectId).toBe("project-machine-a");
    expect(
      federated.getOpenBindings().find((entry) => entry.targetId === "machine-a"),
    ).toEqual(bindingA);
  });

  it("moves an unpinned subscription to the newly displayed adapter on a tab switch", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "durable-subscriptions",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");
    const events: string[] = [];
    const unsubscribe = (federated.ade as unknown as {
      lanes: { onChanged: (listener: (event: string) => void) => () => void };
    }).lanes.onChanged((event) => events.push(event));

    fixture.targetA.emitLaneChange("from-a");
    await federated.openProject("machine-b", "project-machine-b");
    // A is left behind: detached there, attached on B, and the caller's own
    // unsubscribe still works against whichever adapter currently holds it.
    fixture.targetA.emitLaneChange("stale-a");
    fixture.targetB.emitLaneChange("from-b");

    expect(events).toEqual(["from-a", "from-b"]);
    expect(fixture.targetA.laneListenerCount()).toBe(0);
    expect(fixture.targetB.laneListenerCount()).toBe(1);

    unsubscribe();
    fixture.targetB.emitLaneChange("after-unsubscribe");
    expect(events).toEqual(["from-a", "from-b"]);
    expect(fixture.targetB.laneListenerCount()).toBe(0);
  });

  it("re-attaches the displayed project to its own machine after that machine reconnects", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "reconnect-restore",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");
    const events: string[] = [];
    (federated.ade as unknown as {
      lanes: { onChanged: (listener: (event: string) => void) => () => void };
    }).lanes.onChanged((event) => events.push(event));

    const reconnected = fixture.reconnect("machine-a");

    // The tab still belongs to machine-a, so it must follow that machine's new
    // client — not strand itself on the fallback (the first-connected machine).
    expect(federated.getDisplayedTargetId()).toBe("machine-a");
    expect(reconnected.laneListenerCount()).toBe(1);
    expect(fixture.fallback.laneListenerCount()).toBe(0);
    reconnected.emitLaneChange("after-reconnect");
    expect(events).toEqual(["after-reconnect"]);
  });

  it("restores the displayed project on the later snapshot that brings its machine back", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "offline-restore",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");

    fixture.disconnect("machine-a");
    expect(federated.getDisplayedTargetId()).toBe(null);

    const reconnected = fixture.reconnect("machine-a");
    expect(federated.getDisplayedTargetId()).toBe("machine-a");
    expect(reconnected.adapter.bindProject).toHaveBeenCalled();
  });

  it("never moves a subscription pinned to a binding", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "pinned-subscriptions-stay",
      fallbackClient: fixture.fallbackClient,
    });
    const bindingA = await federated.openProject("machine-a", "project-machine-a");
    const listener = vi.fn();
    (federated.ade.agentChat.onEvent as unknown as (
      listener: () => void,
      binding: typeof bindingA,
    ) => () => void)(listener, bindingA);

    await federated.openProject("machine-b", "project-machine-b");

    expect(fixture.targetA.onAgentChatEvent).toHaveBeenCalledOnce();
    expect(fixture.targetB.onAgentChatEvent).not.toHaveBeenCalled();
  });

  it("releases every durable subscription when the workspace is disposed", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "durable-disposal",
      fallbackClient: fixture.fallbackClient,
    });
    await federated.openProject("machine-a", "project-machine-a");
    (federated.ade as unknown as {
      lanes: { onChanged: (listener: () => void) => () => void };
    }).lanes.onChanged(vi.fn());

    federated.dispose();

    expect(fixture.targetA.laneListenerCount()).toBe(0);
  });

  it("protects the federated project target from automatic session parking", async () => {
    const fixture = managerFixture();
    const federated = createFederatedWebAdapter({
      manager: fixture.manager,
      accountClient,
      accountKey: "protected-active-project",
      fallbackClient: fixture.fallbackClient,
    });

    await federated.openProject("machine-a", "project-machine-a");
    federated.activateHub();

    expect(fixture.manager.setProtectedTargetId).toHaveBeenLastCalledWith("machine-a");
  });
});
