import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrossScopeChats, type CrossScopeChatsDeps } from "./crossScopeChats";
import {
  configureExternalChatStore,
  rememberChildWakeToken,
  rememberExternalChat,
  type ExternalParentWake,
} from "../../../../desktop/src/main/services/chat/externalChats";

function fakeRuntime(ids: string[], deliver: () => Promise<string> = async () => "delivered") {
  const chats = {
    deliverExternalChildCompletion: vi.fn(deliver),
    noteExternalParentUnreachable: vi.fn(),
  };
  const runtime = {
    agentChatService: {
      permissionLevelOf: (id: string) => (ids.includes(id) ? "full-auto" : null),
      ...chats,
    },
  };
  return { runtime: runtime as never, chats };
}

function wake(parentSessionId: string, childTurnId = "turn-1", childSessionId = "child-1"): ExternalParentWake {
  return {
    parentSessionId,
    childSessionId,
    childTitle: "Child",
    childProvider: "claude",
    spawnKind: "subagent",
    resultStatus: "completed",
    summary: "done",
    spawnCompletion: { childSessionId, childTitle: "Child", spawnKind: "subagent", status: "completed", childTurnId },
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
  configureExternalChatStore(path.join(stateDir, "external-chats.json"));
  const scopeGet = vi.fn(async () => ({ runtime: options.project?.runtime ?? fakeRuntime([]).runtime }));
  const service = createCrossScopeChats({
    projectRegistry: { list: () => [{ projectId: "project-b", rootPath: "/projects/b" }] },
    scopeRegistry: {
      get: scopeGet,
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
  return { service, stateDir, scopeGet, advance: (ms: number) => { clock += ms; } };
}

describe("cross-scope chat wakes", () => {
  it("delivers to a recorded parent in another scope, and never routes or boots for an unrecorded one", async () => {
    const personal = fakeRuntime(["personal-parent"]);
    const project = fakeRuntime(["child-1"]);
    const { service, scopeGet } = setup({ personal, project });

    // A parent nobody recorded (deleted, or never a chat): the child keeps the
    // old immediate "parent gone" path, and no project is booted to look.
    expect(service.router.route(wake("deleted-parent"))).toBe(false);
    expect(scopeGet).not.toHaveBeenCalled();

    rememberExternalChat("personal-parent", {
      scope: { kind: "personal" },
      machineKey: null,
      machineName: null,
      permissionLevel: "full-auto",
    });
    expect(service.router.route(wake("personal-parent"))).toBe(true);
    await service.pump();

    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionId: "personal-parent", childSessionId: "child-1" }),
    );
    expect(scopeGet).not.toHaveBeenCalled();
  });

  it("retries a failed delivery with backoff, survives a restart, and delivers once", async () => {
    let answer = "failed";
    const personal = fakeRuntime(["personal-parent"], async () => answer);
    const first = setup({ personal });
    rememberExternalChat("personal-parent", { scope: { kind: "personal" }, machineKey: null, machineName: null, permissionLevel: null });
    first.service.router.route(wake("personal-parent"));
    await first.service.pump();

    // Not due yet: nothing is tried.
    await first.service.pump();
    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledTimes(1);

    // A new brain on the same state picks the queued completion up.
    answer = "delivered";
    const second = setup({ personal, stateDir: first.stateDir });
    second.advance(31_000);
    await second.service.pump();
    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledTimes(2);
    // Delivered once: a third brain on the same state has nothing left to send.
    const third = setup({ personal, stateDir: first.stateDir });
    third.advance(60 * 60_000);
    await third.service.pump();
    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the parent is gone", "parent_gone", 0, "parent_gone"],
    ["the parent's machine refuses it", "refused", 0, "refused"],
    ["a day of retries fails", "failed", 25 * 60 * 60_000, "gave_up"],
  ] as const)("tells the child when %s", async (_label, answer, waitMs, reason) => {
    const project = fakeRuntime(["child-1"]);
    const deliverRemote = vi.fn(async () => answer as never);
    const { service, advance, stateDir } = setup({ project, deliverRemote });
    rememberExternalChat("remote:device-a:parent-a", { scope: null, machineKey: "machine-a", machineName: "Mac mini", permissionLevel: null });
    rememberChildWakeToken("child-1", "token");
    service.router.route(wake("remote:device-a:parent-a"));
    await service.pump();
    if (waitMs) {
      advance(waitMs);
      await service.pump();
    }
    expect(project.chats.noteExternalParentUnreachable).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-1", reason, parentMachineName: "Mac mini" }),
    );
    // Dropped, not retried: a later brain on the same state sends nothing.
    const calls = deliverRemote.mock.calls.length;
    const later = setup({ project, deliverRemote, stateDir });
    later.advance(60 * 60_000);
    await later.service.pump();
    expect(deliverRemote).toHaveBeenCalledTimes(calls);
  });

  it("routes a remote parent with its token, waits for a token not yet stored, and keeps the machine reachable meanwhile", async () => {
    const deliverRemote = vi.fn(async () => "delivered" as const);
    const { service, advance } = setup({ deliverRemote });
    expect(service.router.route(wake("remote:device-a:unknown"))).toBe(false);

    rememberExternalChat("remote:device-a:chat-a", { scope: null, machineKey: "machine-a", machineName: "MacBook Pro", permissionLevel: null });
    rememberChildWakeToken("child-2", "token-2");
    // child-1's create has not returned here yet: no token. It waits, and
    // waiting must not mark the machine dark for child-2 in the same pass.
    service.router.route(wake("remote:device-a:chat-a", "turn-1", "child-1"));
    await service.pump();
    advance(31_000);
    service.router.route(wake("remote:device-a:chat-a", "turn-1", "child-2"));
    await service.pump();

    expect(deliverRemote).toHaveBeenCalledTimes(1);
    expect(deliverRemote).toHaveBeenCalledWith("machine-a", expect.objectContaining({
      parentChatSessionId: "chat-a",
      wakeToken: "token-2",
    }));
  });

  it("accepts a wake from another machine only for its own child with that child's token", async () => {
    const personal = fakeRuntime(["parent-a"]);
    const { service } = setup({ personal });
    const payload = (token: string, parentChatSessionId = "parent-a") => ({
      parentChatSessionId,
      wakeToken: token,
      wake: (({ parentSessionId: _p, childProjectRoot: _r, ...rest }) => rest)(wake("parent-a")),
    });

    // Not recorded yet: its create may still be on its way back. Retry.
    await expect(service.acceptRemoteWake(payload("token-1"))).resolves.toBe("pending");

    service.recordRemoteChild({
      parentChatSessionId: "parent-a",
      parentScope: { kind: "personal" },
      childSessionId: "child-1",
      machineKey: "machine-b",
      machineName: "Mac mini",
      wakeToken: "token-1",
    });
    await expect(service.acceptRemoteWake(payload("forged"))).resolves.toBe("refused");
    // A known child claimed for another parent is refused, not left to retry.
    await expect(service.acceptRemoteWake(payload("token-1", "parent-b"))).resolves.toBe("refused");
    await expect(service.acceptRemoteWake({ ...payload("token-1"), wake: { childSessionId: "child-1" } })).resolves.toBe("refused");
    expect(personal.chats.deliverExternalChildCompletion).not.toHaveBeenCalled();

    await expect(service.acceptRemoteWake(payload("token-1"))).resolves.toBe("delivered");
    expect(personal.chats.deliverExternalChildCompletion).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: "parent-a",
      wakeText: expect.stringContaining('ade chat read child-1 --machine "Mac mini"'),
      spawnCompletion: expect.objectContaining({ childMachineName: "Mac mini" }),
    }));
  });
});
