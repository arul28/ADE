import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrossScopeChats, type CrossScopeChatsDeps } from "./crossScopeChats";
import {
  configureExternalChatStore,
  rememberExternalChat,
  type ExternalParentWake,
} from "../../../../desktop/src/main/services/chat/externalChats";

type FakeChats = {
  ids: Set<string>;
  deliverExternalChildCompletion: ReturnType<typeof vi.fn>;
  noteExternalParentUnreachable: ReturnType<typeof vi.fn>;
};

function fakeRuntime(ids: string[], deliver: () => Promise<string> = async () => "delivered") {
  const chats: FakeChats = {
    ids: new Set(ids),
    deliverExternalChildCompletion: vi.fn(deliver),
    noteExternalParentUnreachable: vi.fn(),
  };
  const runtime = {
    agentChatService: {
      permissionLevelOf: (id: string) => (chats.ids.has(id) ? "full-auto" : null),
      deliverExternalChildCompletion: chats.deliverExternalChildCompletion,
      noteExternalParentUnreachable: chats.noteExternalParentUnreachable,
    },
  };
  return { runtime: runtime as never, chats };
}

function wake(parentSessionId: string, childTurnId = "turn-1"): ExternalParentWake {
  return {
    parentSessionId,
    childSessionId: "child-1",
    childTitle: "Child",
    childProvider: "claude",
    spawnKind: "subagent",
    resultStatus: "completed",
    summary: "done",
    spawnCompletion: { childSessionId: "child-1", childTitle: "Child", spawnKind: "subagent", status: "completed", childTurnId },
    wakeText: "Your subagent finished",
    childProjectRoot: "/projects/b",
  };
}

const dirs: string[] = [];
afterEach(() => {
  configureExternalChatStore(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options: {
  personal?: ReturnType<typeof fakeRuntime>;
  project?: ReturnType<typeof fakeRuntime>;
  deliverRemote?: CrossScopeChatsDeps["deliverRemote"];
  stateDir?: string;
}) {
  let clock = 1_000_000;
  const stateDir = options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ade-cross-scope-"));
  if (!options.stateDir) dirs.push(stateDir);
  const service = createCrossScopeChats({
    projectRegistry: { list: () => [{ projectId: "project-b", rootPath: "/projects/b" }] },
    scopeRegistry: {
      get: async () => ({ runtime: options.project?.runtime ?? fakeRuntime([]).runtime }),
      getIfBooted: () => (options.project ? Promise.resolve({ runtime: options.project.runtime }) : null),
    },
    personalChatScope: options.personal
      ? {
          runtimeForDelivery: async () => options.personal!.runtime,
          peekRuntime: () => Promise.resolve(options.personal!.runtime),
        }
      : null,
    deliverRemote: options.deliverRemote ?? null,
    stateDir,
    now: () => clock,
  });
  return { service, stateDir, advance: (ms: number) => { clock += ms; } };
}

describe("cross-scope chat wakes", () => {
  it("delivers a child's completion to a parent in another scope on this machine", async () => {
    const personal = fakeRuntime(["personal-parent"]);
    const project = fakeRuntime(["child-1"]);
    const { service } = setup({ personal, project });

    expect(service.router.route(wake("personal-parent"))).toBe(true);
    await service.pump();

    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionId: "personal-parent", childSessionId: "child-1" }),
    );
    expect(service.pendingCount()).toBe(0);
  });

  it("retries a failed delivery with backoff, and survives a restart", async () => {
    let answer = "failed";
    const personal = fakeRuntime(["personal-parent"], async () => answer);
    const first = setup({ personal });
    first.service.router.route(wake("personal-parent"));
    await first.service.pump();
    expect(first.service.pendingCount()).toBe(1);

    // Not due yet: nothing is tried.
    await first.service.pump();
    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledTimes(1);

    // A new brain on the same state picks the queued completion up.
    answer = "delivered";
    const second = setup({ personal, stateDir: first.stateDir });
    expect(second.service.pendingCount()).toBe(1);
    second.advance(31_000);
    await second.service.pump();
    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledTimes(2);
    expect(second.service.pendingCount()).toBe(0);
  });

  it("tells the child when its parent is gone, and when a day of retries failed", async () => {
    const project = fakeRuntime(["child-1"]);
    const gone = setup({ project });
    gone.service.router.route(wake("deleted-parent"));
    await gone.service.pump();
    expect(project.chats.noteExternalParentUnreachable).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-1", reason: "parent_gone" }),
    );

    const personal = fakeRuntime(["personal-parent"], async () => "failed");
    const stuck = setup({ personal, project });
    stuck.service.router.route(wake("personal-parent", "turn-2"));
    await stuck.service.pump();
    stuck.advance(25 * 60 * 60_000);
    await stuck.service.pump();
    expect(project.chats.noteExternalParentUnreachable).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-1", reason: "gave_up" }),
    );
    expect(stuck.service.pendingCount()).toBe(0);
  });

  it("routes a remote parent to its machine, and refuses a remote parent with no known machine", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cross-scope-"));
    dirs.push(stateDir);
    configureExternalChatStore(path.join(stateDir, "external-chats.json"));
    const deliverRemote = vi.fn(async () => "delivered" as const);
    const { service } = setup({ deliverRemote, stateDir });

    expect(service.router.route(wake("remote:device-a:chat-unknown"))).toBe(false);

    rememberExternalChat("remote:device-a:chat-a", {
      scope: null,
      machineKey: "machine-a",
      machineName: "MacBook Pro",
      permissionLevel: "full-auto",
    });
    expect(service.router.route(wake("remote:device-a:chat-a"))).toBe(true);
    await service.pump();
    expect(deliverRemote).toHaveBeenCalledWith(
      "machine-a",
      expect.objectContaining({ parentChatSessionId: "chat-a" }),
    );
  });

  it("accepts a wake from another machine only for a child this brain started there", async () => {
    const personal = fakeRuntime(["parent-a"]);
    const { service } = setup({ personal });
    const payload = {
      parentChatSessionId: "parent-a",
      wake: (({ parentSessionId: _p, childProjectRoot: _r, ...rest }) => rest)(wake("parent-a")),
    };

    await expect(service.acceptRemoteWake(payload)).rejects.toThrow(/No chat here started that child/);
    expect(personal.chats.deliverExternalChildCompletion).not.toHaveBeenCalled();

    service.recordRemoteChild({
      parentChatSessionId: "parent-a",
      parentScope: { kind: "personal" },
      childSessionId: "child-1",
      machineKey: "machine-b",
      machineName: "Mac mini",
    });
    await expect(service.acceptRemoteWake(payload)).resolves.toBe("delivered");
    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "parent-a",
      wakeText: expect.stringContaining('ade chat read child-1 --machine "Mac mini"'),
      spawnCompletion: expect.objectContaining({ childMachineName: "Mac mini" }),
    }));

    // Same child, a different parent: still refused.
    await expect(service.acceptRemoteWake({ ...payload, parentChatSessionId: "parent-z" }))
      .rejects.toThrow(/No chat here started that child/);
  });
});
