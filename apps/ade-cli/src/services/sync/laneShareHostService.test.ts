import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createLaneShareRightsStore, ensureLaneShareRightsSchema } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import { laneSharePresetRights, type LaneShareRights } from "../../../../desktop/src/shared/laneShareRights";
import { createLaneShareAgentRate, createLaneShareHostService, type LaneShareAgentRate } from "./laneShareHostService";
import { createLaneShareMoveService } from "./laneShareMoveService";

type DatabaseSyncType = {
  prepare(sql: string): { run(...params: never[]): unknown; get(...params: never[]): unknown; all(...params: never[]): unknown[] };
  exec(sql: string): void;
};

const laneId = "lane-shared";
const grantId = `ls_${"a".repeat(32)}`;

/** A real rights store on an in-memory SQLite, with one open lane. */
function makeStore() {
  const require_ = createRequire(import.meta.url);
  const { DatabaseSync } = require_("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncType };
  const sqlite = new DatabaseSync(":memory:");
  const db = {
    run: (sql: string, params: unknown[] = []) => {
      sqlite.prepare(sql).run(...(params as never[]));
    },
    get: (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...(params as never[])) ?? null,
    all: (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...(params as never[])),
  } as never;
  ensureLaneShareRightsSchema(db);
  sqlite.exec("create table lanes (id text primary key, archived_at text)");
  sqlite.prepare("insert into lanes (id, archived_at) values (?, null)").run(laneId as never);
  return createLaneShareRightsStore({ db });
}

/**
 * The service with the account directory at the network boundary, on a
 * darwin host unless the test names another. The person saved no default
 * rights unless `readDefaultRights` says otherwise.
 */
function makeService(
  directory: (url: string, init?: RequestInit) => Promise<Response>,
  platform: NodeJS.Platform = "darwin",
  now: () => number = Date.now,
  extra: { agentRate?: LaneShareAgentRate; readDefaultRights?: () => unknown } = {},
) {
  const store = makeStore();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => directory(String(input), init));
  const service = createLaneShareHostService({
    access: { getAccessToken: async () => "owner-token", getDirectoryBaseUrl: () => "http://127.0.0.1:9", fetchImpl: fetchImpl as unknown as typeof fetch },
    getMachineKey: () => "machine-1",
    store,
    getHost: () => null,
    getRepoKey: () => "repo:github.com/acme/widgets",
    getProjectLabel: () => "widgets",
    getLaneLabel: () => "shared",
    platform,
    now,
    agentRate: extra.agentRate ?? createLaneShareAgentRate(now),
    readDefaultRights: extra.readDefaultRights ?? (() => undefined),
  });
  return { service, store, fetchImpl };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const invited = () => json(201, { grant: { id: grantId } });

/** Typing into a CLI session: high risk. */
const highRisk = (): LaneShareRights => {
  const rights = laneSharePresetRights("watch");
  rights.run.typeInCliSessions = true;
  return rights;
};

describe("lane share host service", () => {
  it.each<[string, () => Promise<Response>, string]>([
    ["is down", async () => json(503, { error: { code: "down", message: "Down" } }), "unavailable"],
    ["refuses the invite", async () => json(400, { error: { code: "receiver_limit", message: "Too many guests" } }), "directory_refused"],
    ["says the owner is signed out", async () => json(401, {}), "signed_out"],
    ["cannot be reached", async () => { throw new TypeError("fetch failed"); }, "unavailable"],
    ["answers with no grant id", async () => json(201, { grant: {} }), "unavailable"],
  ])("stores nothing when the directory %s", async (_label, answer, code) => {
    const { service, store } = makeService(answer);
    await expect(service.create({ laneId, receiverEmail: "guest@example.com", rights: laneSharePresetRights("comment") }, "person"))
      .rejects.toMatchObject({ code });
    expect(store.list()).toEqual([]);
  });

  it.each<[string, (service: ReturnType<typeof makeService>["service"]) => Promise<unknown>]>([
    ["a new share", (service) => service.create({ laneId, receiverEmail: "guest@example.com", rights: highRisk() }, "person")],
    ["an edit", (service) => service.updateRights({ grantId, rights: highRisk() }, "person")],
  ])("refuses high-risk rights for %s without the owner's confirmation, and changes nothing", async (_label, act) => {
    const { service, store, fetchImpl } = makeService(async () => invited());
    store.put({ grantId, laneId, receiverEmail: "guest@example.com", rights: laneSharePresetRights("watch") });
    fetchImpl.mockClear();
    await expect(act(service)).rejects.toMatchObject({ code: "confirm_high_risk" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.list().map((record) => record.rights)).toEqual([laneSharePresetRights("watch")]);
  });

  // A Windows host cannot let a guest type into a CLI: it stores the right
  // as off, so the risk and the stored rights match what it enforces, and
  // shows a right stored before as off.
  it.each<[NodeJS.Platform, boolean]>([
    ["win32", false],
    ["darwin", true],
    ["linux", true],
  ])("on a %s host, CLI typing is stored and listed as %s", async (platform, available) => {
    const { service, store } = makeService(async (url, init) => (init?.method ?? "GET") === "GET" && url.endsWith("/lane-shares/given")
      ? json(200, { grants: [{ id: grantId, state: "active", laneId, machineKey: "machine-1", repoKey: "repo:github.com/acme/widgets" }] })
      : invited(), platform);
    // High risk needs the owner's confirmation only where the right is kept.
    const created = await service.create({ laneId, receiverEmail: "guest@example.com", rights: highRisk(), confirmHighRisk: available }, "person");
    expect(created.risk.level).toBe(available ? "high" : "low");
    expect(store.get(grantId)?.rights.run.typeInCliSessions).toBe(available);
    const edited = await service.updateRights({ grantId, rights: highRisk(), confirmHighRisk: available }, "person");
    expect(edited.risk.level).toBe(available ? "high" : "low");
    expect(store.get(grantId)?.rights.run.typeInCliSessions).toBe(available);
    // A share stored with the right on (an older build) lists as this host enforces it.
    store.updateRights(grantId, highRisk());
    const listed = await service.list();
    expect(listed.cliTyping).toEqual(available ? { available: true, reason: null } : { available: false, reason: "windows_host" });
    expect(listed.shares[0]).toMatchObject({ rights: { run: { typeInCliSessions: available } }, risk: { level: available ? "high" : "low" } });
  });
});

// An agent (the `ade` CLI, an agent's shell, ADE MCP) may list, make a Watch
// share and stop a share of this machine. The worst share it can make cannot
// change anything here.
describe("lane share host service, a share made by an agent", () => {
  const otherMachineGrant = `ls_${"d".repeat(32)}`;
  /** A directory that invites with a new grant id each time and lists this machine's grants. */
  function makeAgentService(now: () => number = Date.now, extra: Parameters<typeof makeService>[3] = {}) {
    let next = 0;
    const made: string[] = [];
    const harness = makeService(async (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/lane-shares/given")) {
        return json(200, {
          grants: [
            ...made.map((id) => ({ id, state: "pending", laneId, machineKey: "machine-1", repoKey: "repo:github.com/acme/widgets" })),
            { id: otherMachineGrant, state: "active", laneId, machineKey: "machine-2", repoKey: "repo:github.com/acme/widgets" },
          ],
        });
      }
      if (method === "POST" && url.endsWith("/lane-shares")) {
        const id = `ls_${(next++).toString(16).padStart(32, "0")}`;
        made.push(id);
        return json(201, { grant: { id } });
      }
      return json(200, { grant: { state: "revoked" } });
    }, "darwin", now, extra);
    return harness;
  }

  it("makes a Watch share when it names no rights, records it as an agent's, and lists it so", async () => {
    const { service, store } = makeAgentService();
    const created = await service.create({ laneId, receiverEmail: "guest@example.com" }, "agent");
    expect(created.risk.level).toBe("low");
    expect(created.createdBy).toBe("agent");
    expect(store.get(created.grantId)).toMatchObject({ createdBy: "agent", rights: laneSharePresetRights("watch") });
    // The privacy switches and an end date are allowed.
    const hidden = laneSharePresetRights("watch");
    hidden.privacy = { hideMachines: true, hideModels: true };
    const second = await service.create({ laneId, receiverEmail: "other@example.com", rights: hidden, endsAt: Date.now() + 60_000 }, "agent");
    expect(store.get(second.grantId)?.rights.privacy).toEqual({ hideMachines: true, hideModels: true });
    const listed = await service.list();
    expect(listed.shares.find((share) => share.grantId === created.grantId)).toMatchObject({ createdBy: "agent", risk: { level: "low" } });
  });

  it.each<[string, (rights: LaneShareRights) => void, Record<string, unknown>?]>([
    ["send", (rights) => { rights.speak.send = true; }],
    ["steer", (rights) => { rights.speak.steer = true; }],
    ["comment", (rights) => { rights.speak.comment = true; }],
    ["drafts", (rights) => { rights.speak.drafts = true; }],
    ["startChats", (rights) => { rights.run.startChats = true; }],
    ["startCliSessions", (rights) => { rights.run.startCliSessions = true; }],
    ["typeInCliSessions", (rights) => { rights.run.typeInCliSessions = true; }],
    ["approvals", (rights) => { rights.decide.approvals = true; }],
    ["questions", (rights) => { rights.decide.questions = true; }],
    ["a tools read", (rights) => { rights.tools.file = true; }],
    ["the terminal tools switch", (rights) => { rights.tools.terminal = true; }],
    ["history before the share", (rights) => { rights.see.historyBeforeShare = true; }],
    ["a confirmed high risk", () => {}, { confirmHighRisk: true }],
  ])("refuses an agent's share with %s, and stores and sends nothing", async (_label, change, extra = {}) => {
    const { service, store, fetchImpl } = makeAgentService();
    const rights = laneSharePresetRights("watch");
    change(rights);
    await expect(service.create({ laneId, receiverEmail: "guest@example.com", rights, ...extra }, "agent"))
      .rejects.toMatchObject({ code: "agent_watch_only", message: expect.stringContaining("only a Watch share") });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  const personOnly = { code: "person_only", message: "Only a person in the ADE app can do this." };
  it.each<[string, "agent" | "person", { code: string; message: string }, (service: ReturnType<typeof makeService>["service"]) => Promise<unknown>]>([
    ["change rights", "agent", personOnly, (service) => service.updateRights({ grantId, rights: laneSharePresetRights("watch") }, "agent")],
    ["send an invite again", "agent", personOnly, (service) => service.resendInvite({ grantId }, "agent")],
    ["leave a share", "agent", personOnly, (service) => service.leave({ grantId }, "agent")],
    ["read the shares given to the account", "agent", personOnly, (service) => service.listReceived("agent")],
    // The directory would reuse the grant, and Watch rights would replace the person's.
    [
      "share again with a person who has a pending share of the lane",
      "person",
      { code: "invalid_args", message: "This person already has a share of this lane. Change it in the ADE app." },
      (service) => service.create({ laneId, receiverEmail: "GUEST@example.com" }, "agent"),
    ],
  ])("refuses an agent that asks to %s", async (_label, createdBy, refusal, act) => {
    const { service, store, fetchImpl } = makeAgentService();
    const kept = laneSharePresetRights("comment");
    kept.privacy = { hideMachines: true, hideModels: true };
    kept.limits.endsAt = Date.now() + 24 * 60 * 60 * 1000;
    store.put({ grantId, laneId, receiverEmail: "guest@example.com", rights: kept, createdBy });
    await expect(act(service)).rejects.toMatchObject(refusal);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.get(grantId)).toMatchObject({ rights: kept, createdBy });
  });

  it("lets an agent stop a share of this machine, by grant id or email, but not one of another machine", async () => {
    const { service, store } = makeAgentService();
    const byId = await service.create({ laneId, receiverEmail: "guest@example.com" }, "agent");
    await service.create({ laneId, receiverEmail: "other@example.com" }, "agent");
    await expect(service.revoke({ grantId: byId.grantId }, "agent")).resolves.toMatchObject({ grantId: byId.grantId, directoryRevoked: true });
    await expect(service.revoke({ laneId, receiverEmail: "OTHER@example.com" }, "agent")).resolves.toMatchObject({ directoryRevoked: true });
    expect(store.list()).toEqual([]);
    await expect(service.revoke({ grantId: otherMachineGrant }, "agent")).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets an agent make 5 shares an hour on this machine, across its projects, then refuses until the hour has passed", async () => {
    let clock = Date.UTC(2026, 10, 10, 12);
    // A brain runs one host service per open project; they share one counter.
    const agentRate = createLaneShareAgentRate(() => clock);
    const { service } = makeAgentService(() => clock, { agentRate });
    const { service: otherProject } = makeAgentService(() => clock, { agentRate });
    for (let index = 0; index < 5; index += 1) {
      await (index % 2 === 0 ? service : otherProject).create({ laneId, receiverEmail: `guest${index}@example.com` }, "agent");
    }
    for (const project of [service, otherProject]) {
      await expect(project.create({ laneId, receiverEmail: "guest5@example.com" }, "agent"))
        .rejects.toMatchObject({ code: "rate_limited", message: expect.stringContaining("at most 5 lane shares an hour") });
    }
    // A person is not counted.
    await service.create({ laneId, receiverEmail: "person@example.com", rights: laneSharePresetRights("comment") }, "person");
    clock += 60 * 60 * 1000;
    await expect(service.create({ laneId, receiverEmail: "guest5@example.com" }, "agent")).resolves.toMatchObject({ createdBy: "agent" });
  });

  it.each<[string, () => unknown, { hideMachines?: boolean; hideModels?: boolean }, { hideMachines: boolean; hideModels: boolean }]>([
    // Collaborate defaults: only their hiding counts, and the call cannot drop it.
    ["hides what the person's defaults hide, plus what the call adds", () => ({ preset: "custom", rights: { ...laneSharePresetRights("collaborate"), privacy: { hideMachines: true, hideModels: false } } }), { hideModels: true }, { hideMachines: true, hideModels: true }],
    ["hides both when the defaults cannot be read", () => { throw new Error("no settings"); }, {}, { hideMachines: true, hideModels: true }],
  ])("an agent's share %s, and takes nothing else from them", async (_label, readDefaultRights, flags, privacy) => {
    const { service, store } = makeAgentService(Date.now, { readDefaultRights });
    const rights = laneSharePresetRights("watch");
    rights.privacy = { hideMachines: flags.hideMachines ?? false, hideModels: flags.hideModels ?? false };
    const created = await service.create({ laneId, receiverEmail: "guest@example.com", rights }, "agent");
    expect(store.get(created.grantId)?.rights).toEqual({ ...laneSharePresetRights("watch"), privacy });
  });

  it("lets a person raise an agent's share, which keeps its label", async () => {
    const { service, store } = makeAgentService();
    const created = await service.create({ laneId, receiverEmail: "guest@example.com" }, "agent");
    const raised = await service.updateRights({ grantId: created.grantId, rights: laneSharePresetRights("collaborate") }, "person");
    expect(raised.risk.level).toBe("medium");
    expect(store.get(created.grantId)).toMatchObject({ createdBy: "agent", rights: { speak: { send: true } } });
  });
});

describe("lane share move consent", () => {
  const sha = "c".repeat(40);
  const collaborate = () => laneSharePresetRights("collaborate" as never);
  const guest = (rights = collaborate()) => ({ grantId, laneId, userId: "user-guest", name: "Guest", rights });
  const otherGrant = { ...guest(), grantId: `ls_${"b".repeat(32)}` };

  /** The move service on a real rights store; the chat side is the service's own port. */
  function makeMoves(share: Parameters<typeof createLaneShareMoveService>[0]["share"] = () => null) {
    const store = makeStore();
    store.put({ grantId, laneId, receiverEmail: "guest@example.com", rights: collaborate() });
    const landed = vi.fn(async () => ({ laneId: "lane-new", laneName: "moved", sessionId: "chat-new", branchName: "fix/login", note: null }));
    let laneDiscarded: (laneId: string) => void = () => {};
    const discardedOnce = new Promise<string>((resolve) => { laneDiscarded = resolve; });
    const discarded = vi.fn(async (laneId: string) => { laneDiscarded(laneId); });
    // The service logs `lane_share.move_ended` once per move, with its final stage: the receipt a test waits on.
    const endedStages = new Map<string, string>();
    const endedWaiters = new Map<string, (stage: string) => void>();
    const logger = {
      info: (event: string, fields?: Record<string, unknown>) => {
        if (event !== "lane_share.move_ended") return;
        const id = String(fields?.moveId);
        endedStages.set(id, String(fields?.stage));
        endedWaiters.get(id)?.(String(fields?.stage));
      },
      warn: () => {},
    };
    const ended = (id: string): Promise<string> => endedStages.has(id)
      ? Promise.resolve(endedStages.get(id)!)
      : new Promise((resolve) => endedWaiters.set(id, resolve));
    const moves = createLaneShareMoveService({
      chat: () => ({
        getSessionSummary: async () => ({ laneId, title: "Fix", modelId: null }),
        prepareLaneShareMove: async () => { throw new Error("not used"); },
        checkLaneShareMoveDestination: async () => ({ modelId: "m" }),
        acceptLaneShareMove: landed,
        markLaneShareMoved: async () => {},
        discardLaneShareMoveLane: discarded,
      }),
      rightsStore: store,
      share,
      getRepoKey: () => "repo:github.com/acme/widgets",
      getAccountEmail: () => "owner@example.com",
      notifyGuests: () => {},
      logger,
    });
    return { moves, landed, discarded, discardedOnce, ended, store };
  }

  const moveId = (n: string) => `lsm_${n.repeat(32)}`;
  const offer = (moves: ReturnType<typeof makeMoves>["moves"], n: string) => moves.guestCommand(guest(), {
    op: "offer", moveId: moveId(n), laneName: "login", branchName: "fix/login", repoKey: "repo:github.com/acme/widgets", chatTitle: "Fix",
  });
  const payload = (id: string, bundle: Record<string, unknown> | null = null) => ({
    version: 1, moveId: id, title: "Fix", laneName: "login", branchName: "fix/login", headSha: sha,
    repoKey: "repo:github.com/acme/widgets", modelHint: null, brief: "b", continuationPrompt: "c",
    artifacts: { fileChanges: [], commands: [], errors: [] }, linearIssues: [], bundle,
  });

  it.each<[string, RegExp, (moves: ReturnType<typeof makeMoves>["moves"]) => Promise<unknown>]>([
    ["a chunk of the owner's move before the guest accepts", /not ready to send/, async (moves) => {
      const view = await moves.start({ grantId, sessionId: "chat-1" });
      return moves.guestCommand(guest(), { op: "chunk", moveId: view.moveId, index: 0 });
    }],
    ["the payload of the owner's move before the guest accepts", /not ready to send/, async (moves) => {
      const view = await moves.start({ grantId, sessionId: "chat-1" });
      return moves.guestCommand(guest(), { op: "payload", moveId: view.moveId });
    }],
    ["the guest's work before the owner accepts", /has not accepted/, async (moves) => {
      await offer(moves, "4");
      return moves.guestCommand(guest(), { op: "begin", moveId: moveId("4"), payload: payload(moveId("4")) });
    }],
    ["a finish before the owner accepts", /has not accepted/, async (moves) => {
      await offer(moves, "4");
      return moves.guestCommand(guest(), { op: "finish", moveId: moveId("4") });
    }],
    ["another grant's step on this move", /no such move/, async (moves) => {
      await offer(moves, "4");
      await moves.respond({ moveId: moveId("4"), accept: true });
      return moves.guestCommand(otherGrant, { op: "begin", moveId: moveId("4"), payload: payload(moveId("4")) });
    }],
    ["a guest without Collaborate", /does not include moving/, async (moves) => moves.guestCommand(guest(laneSharePresetRights("watch")), {
      op: "offer", moveId: moveId("4"), laneName: "login", branchName: "fix/login", repoKey: "repo:github.com/acme/widgets",
    })],
  ])("refuses %s", async (_label, refusal, step) => {
    const { moves, landed } = makeMoves();
    await expect(step(moves)).rejects.toThrow(refusal);
    expect(landed).not.toHaveBeenCalled();
    moves.dispose();
  });

  it("uses a consent once, allows one move at a time, and lets it expire after 15 minutes", async () => {
    vi.useFakeTimers();
    try {
      const { moves, landed, ended } = makeMoves();
      await offer(moves, "5");
      await expect(moves.start({ grantId, sessionId: "chat-1" })).rejects.toThrow(/already waiting/);
      moves.respond({ moveId: moveId("5"), accept: true });
      await moves.guestCommand(guest(), { op: "begin", moveId: moveId("5"), payload: payload(moveId("5")) });
      await moves.guestCommand(guest(), { op: "finish", moveId: moveId("5") });
      expect(await ended(moveId("5"))).toBe("done");
      expect((await moves.guestCommand(guest(), { op: "status", moveId: moveId("5") }) as { stage: string }).stage).toBe("done");
      // The same move id again: its consent is spent.
      await expect(moves.guestCommand(guest(), { op: "finish", moveId: moveId("5") })).rejects.toThrow(/already ended/);
      await expect(offer(moves, "5")).rejects.toThrow(/already/);
      expect(landed).toHaveBeenCalledTimes(1);

      await offer(moves, "6");
      vi.advanceTimersByTime(15 * 60_000);
      expect(() => moves.respond({ moveId: moveId("6"), accept: true })).toThrow(/expired|already ended|no such move/);
      moves.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // The guest may be gone while the lane lands: the host checks the share
  // again from its own rights row before the move counts as done.
  it.each<[string, (store: ReturnType<typeof makeMoves>["store"]) => void]>([
    ["the share was revoked", (store) => { store.deleteRights(grantId); }],
    ["the end date passed", (store) => {
      const rights = collaborate();
      store.updateRights(grantId, { ...rights, limits: { ...rights.limits, endsAt: Date.now() - 1_000 } });
    }],
    ["the rights no longer allow a move", (store) => { store.updateRights(grantId, laneSharePresetRights("watch")); }],
  ])("removes a landed lane when %s while it landed", async (_label, change) => {
    const { moves, landed, discardedOnce, ended, store } = makeMoves();
    landed.mockImplementationOnce(async () => {
      change(store);
      return { laneId: "lane-new", laneName: "moved", sessionId: "chat-new", branchName: "fix/login", note: null };
    });
    await offer(moves, "8");
    moves.respond({ moveId: moveId("8"), accept: true });
    await moves.guestCommand(guest(), { op: "begin", moveId: moveId("8"), payload: payload(moveId("8")) });
    await moves.guestCommand(guest(), { op: "finish", moveId: moveId("8") });
    expect(await ended(moveId("8"))).toBe("cancelled");
    expect(await discardedOnce).toBe("lane-new");
    moves.dispose();
  });

  it("never lands a bundle whose checksum does not match", async () => {
    const { moves, landed, ended } = makeMoves();
    const data = Buffer.from("not really a bundle");
    const info = { bytes: data.length, sha256: "d".repeat(64), chunkCount: 1, branchHeadSha: sha, snapshotSha: null, unpushedCommitCount: 1, changedFileCount: 1 };
    await offer(moves, "7");
    moves.respond({ moveId: moveId("7"), accept: true });
    await moves.guestCommand(guest(), { op: "begin", moveId: moveId("7"), payload: payload(moveId("7"), info) });
    const sent = (async () => {
      await moves.guestCommand(guest(), { op: "put", moveId: moveId("7"), index: 0, data: data.toString("base64") });
      await moves.guestCommand(guest(), { op: "finish", moveId: moveId("7") });
    })();
    await sent.catch(() => undefined);
    expect(await ended(moveId("7"))).toBe("failed");
    expect((await moves.guestCommand(guest(), { op: "status", moveId: moveId("7") }) as { stage: string }).stage).toBe("failed");
    expect(landed).not.toHaveBeenCalled();
    moves.dispose();
  });

  // The share back goes only to the other person of this grant, as the
  // directory names them to this machine's account (never the peer's word).
  // "giver": the owner lands a guest's move; "receiver": the guest lands the
  // owner's move on its own machine.
  it.each<[string, "giver" | "receiver", { role: "giver" | "receiver"; userId: string; email: string | null }, string | null]>([
    ["shares back to the guest of the grant", "giver", { role: "giver", userId: "user-guest", email: "guest@example.com" }, "guest@example.com"],
    ["shares nothing back when the grant's guest is another user", "giver", { role: "giver", userId: "user-other", email: "other@example.com" }, null],
    ["shares back to the owner of the grant", "receiver", { role: "receiver", userId: "user-owner", email: null }, "owner@example.com"],
    ["shares nothing back when this account is not the grant's receiver", "receiver", { role: "giver", userId: "user-owner", email: "x@example.com" }, null],
  ])("%s", async (_label, side, party, expectedEmail) => {
    const create = vi.fn(async () => ({ grantId: `ls_${"e".repeat(32)}` }));
    const { moves, landed, ended } = makeMoves(() => ({ create, shareBackParty: async () => party, acceptShareBack: async () => {}, revoke: async () => {} }));
    let result: () => Promise<{ stage: string; result: { shareBackGrantId: string | null; note: string | null } | null }>;
    if (side === "giver") {
      await offer(moves, "9");
      moves.respond({ moveId: moveId("9"), accept: true });
      await moves.guestCommand(guest(), { op: "begin", moveId: moveId("9"), payload: payload(moveId("9")) });
      await moves.guestCommand(guest(), { op: "finish", moveId: moveId("9") });
      result = async () => await moves.guestCommand(guest(), { op: "status", moveId: moveId("9") }) as never;
    } else {
      await moves.receivePrepare({ moveId: moveId("9"), grantId, repoKey: "repo:github.com/acme/widgets" });
      moves.receiveBegin({ moveId: moveId("9"), grantId, payload: payload(moveId("9")) });
      moves.receiveLand({ moveId: moveId("9"), grantId, fromName: "Owner", shareBack: { receiverEmail: "owner@example.com", rights: laneSharePresetRights("watch") } });
      result = async () => moves.receiveStatus({ moveId: moveId("9"), grantId }) as never;
    }
    expect(await ended(moveId("9"))).toBe("done");
    expect(landed).toHaveBeenCalledTimes(1);
    const done = (await result()).result!;
    if (expectedEmail) {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ receiverEmail: expectedEmail, shareBackOf: grantId }));
      expect(done).toMatchObject({ shareBackGrantId: `ls_${"e".repeat(32)}`, note: null });
    } else {
      expect(create).not.toHaveBeenCalled();
      expect(done.shareBackGrantId).toBeNull();
      expect(done.note).toMatch(/not shared back/);
    }
    moves.dispose();
  });

  // A cancel that arrives while the directory makes the share back: the
  // share just made ends, and the landed lane goes again (both landings).
  it.each<[string, "giver" | "receiver"]>([
    ["the owner's landing of a guest's move", "giver"],
    ["the guest's landing of the owner's move", "receiver"],
  ])("ends the share back and discards the lane when a cancel arrives during %s", async (_label, side) => {
    const madeId = `ls_${"f".repeat(32)}`;
    const revoke = vi.fn(async (_grantId: string) => {});
    let cancelNow: () => void = () => {};
    const create = vi.fn(async () => {
      cancelNow();
      return { grantId: madeId };
    });
    const party = side === "giver"
      ? { role: "giver" as const, userId: "user-guest", email: "guest@example.com" }
      : { role: "receiver" as const, userId: "user-owner", email: null };
    const { moves, discardedOnce } = makeMoves(() => ({ create, shareBackParty: async () => party, acceptShareBack: async () => {}, revoke }));
    let stage: () => Promise<string>;
    if (side === "giver") {
      await offer(moves, "a");
      moves.respond({ moveId: moveId("a"), accept: true });
      cancelNow = () => { moves.cancel({ moveId: moveId("a") }); };
      await moves.guestCommand(guest(), { op: "begin", moveId: moveId("a"), payload: payload(moveId("a")) });
      await moves.guestCommand(guest(), { op: "finish", moveId: moveId("a") });
      stage = async () => ((await moves.guestCommand(guest(), { op: "status", moveId: moveId("a") })) as { stage: string }).stage;
    } else {
      await moves.receivePrepare({ moveId: moveId("a"), grantId, repoKey: "repo:github.com/acme/widgets" });
      moves.receiveBegin({ moveId: moveId("a"), grantId, payload: payload(moveId("a")) });
      cancelNow = () => { moves.receiveCancel({ moveId: moveId("a"), grantId }); };
      moves.receiveLand({ moveId: moveId("a"), grantId, fromName: "Owner", shareBack: { receiverEmail: "owner@example.com", rights: laneSharePresetRights("watch") } });
      stage = async () => moves.receiveStatus({ moveId: moveId("a"), grantId }).stage;
    }
    expect(await discardedOnce).toBe("lane-new");
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(madeId);
    expect(await stage()).toBe("cancelled");
    moves.dispose();
  });

  it("refuses a bundle over 50 MiB before any part arrives", async () => {
    const { moves, landed } = makeMoves();
    await offer(moves, "8");
    moves.respond({ moveId: moveId("8"), accept: true });
    const bytes = 50 * 1024 * 1024 + 1;
    const info = { bytes, sha256: "d".repeat(64), chunkCount: Math.ceil(bytes / (384 * 1024)), branchHeadSha: sha, snapshotSha: null, unpushedCommitCount: 1, changedFileCount: 1 };
    await expect(moves.guestCommand(guest(), { op: "begin", moveId: moveId("8"), payload: payload(moveId("8"), info) })).rejects.toThrow();
    await expect(moves.guestCommand(guest(), { op: "put", moveId: moveId("8"), index: 0, data: "AA==" })).rejects.toThrow();
    expect(landed).not.toHaveBeenCalled();
    moves.dispose();
  });
});
