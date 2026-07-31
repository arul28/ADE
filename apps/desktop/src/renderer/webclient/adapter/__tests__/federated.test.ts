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
  const adapter = {
    ade: {
      app: {},
      project: {},
      remoteRuntime: {},
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
  return { adapter, createPromptStash, onAgentChatEvent };
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
      return { session, project };
    }),
    park: vi.fn(async () => undefined),
    forgetEnvironment: vi.fn(async () => undefined),
    listEnvironments: vi.fn(() => []),
  } as unknown as WebMachineSessionManager;
  return {
    manager,
    fallbackClient,
    clientA,
    targetA,
    targetB,
    sessions,
    emitSnapshot() {
      for (const listener of listeners) listener({ sessions });
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
      expect(result).toBe(unsubscribe);
      expect(onUpdate).toHaveBeenCalledOnce();
    });
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
});
