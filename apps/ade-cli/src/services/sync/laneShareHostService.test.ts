import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createLaneShareRightsStore, ensureLaneShareRightsSchema } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import { laneSharePresetRights, type LaneShareRights } from "../../../../desktop/src/shared/laneShareRights";
import { createLaneShareHostService } from "./laneShareHostService";
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

/** The service with the account directory at the network boundary. */
function makeService(directory: (url: string, init?: RequestInit) => Promise<Response>) {
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
    await expect(service.create({ laneId, receiverEmail: "guest@example.com", rights: laneSharePresetRights("comment") }))
      .rejects.toMatchObject({ code });
    expect(store.list()).toEqual([]);
  });

  it.each<[string, (service: ReturnType<typeof makeService>["service"]) => Promise<unknown>]>([
    ["a new share", (service) => service.create({ laneId, receiverEmail: "guest@example.com", rights: highRisk() })],
    ["an edit", (service) => service.updateRights({ grantId, rights: highRisk() })],
  ])("refuses high-risk rights for %s without the owner's confirmation, and changes nothing", async (_label, act) => {
    const { service, store, fetchImpl } = makeService(async () => invited());
    store.put({ grantId, laneId, receiverEmail: "guest@example.com", rights: laneSharePresetRights("watch") });
    fetchImpl.mockClear();
    await expect(act(service)).rejects.toMatchObject({ code: "confirm_high_risk" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.list().map((record) => record.rights)).toEqual([laneSharePresetRights("watch")]);
  });

  it("stores high-risk rights once the owner confirms them", async () => {
    const { service, store } = makeService(async () => invited());
    await service.create({ laneId, receiverEmail: "guest@example.com", rights: highRisk(), confirmHighRisk: true });
    expect(store.get(grantId)?.rights.run.typeInCliSessions).toBe(true);
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
    const discarded = vi.fn(async (_laneId: string) => {});
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
    });
    return { moves, landed, discarded };
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
      const { moves, landed } = makeMoves();
      await offer(moves, "5");
      await expect(moves.start({ grantId, sessionId: "chat-1" })).rejects.toThrow(/already waiting/);
      moves.respond({ moveId: moveId("5"), accept: true });
      await moves.guestCommand(guest(), { op: "begin", moveId: moveId("5"), payload: payload(moveId("5")) });
      await moves.guestCommand(guest(), { op: "finish", moveId: moveId("5") });
      await vi.waitFor(async () => expect((await moves.guestCommand(guest(), { op: "status", moveId: moveId("5") }) as { stage: string }).stage).toBe("done"));
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

  it.each<[string, (data: Buffer) => { bundle: Record<string, unknown>; chunks: Array<[number, string]> }]>([
    ["a checksum that does not match", (data) => ({
      bundle: { bytes: data.length, sha256: "d".repeat(64), chunkCount: 1 },
      chunks: [[0, data.toString("base64")]],
    })],
  ])("never lands a bundle with %s", async (_label, make) => {
    const { moves, landed } = makeMoves();
    const { bundle, chunks } = make(Buffer.from("not really a bundle"));
    const info = { ...bundle, branchHeadSha: sha, snapshotSha: null, unpushedCommitCount: 1, changedFileCount: 1 };
    await offer(moves, "7");
    moves.respond({ moveId: moveId("7"), accept: true });
    await moves.guestCommand(guest(), { op: "begin", moveId: moveId("7"), payload: payload(moveId("7"), info) });
    const sent = (async () => {
      for (const [index, data] of chunks) await moves.guestCommand(guest(), { op: "put", moveId: moveId("7"), index, data });
      await moves.guestCommand(guest(), { op: "finish", moveId: moveId("7") });
    })();
    await sent.catch(() => undefined);
    await vi.waitFor(async () => expect((await moves.guestCommand(guest(), { op: "status", moveId: moveId("7") }) as { stage: string }).stage).toBe("failed"));
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
    const { moves, landed } = makeMoves(() => ({ create, shareBackParty: async () => party, acceptShareBack: async () => {}, revoke: async () => {} }));
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
    await vi.waitFor(async () => expect((await result()).stage).toBe("done"));
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
    const { moves, discarded } = makeMoves(() => ({ create, shareBackParty: async () => party, acceptShareBack: async () => {}, revoke }));
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
    await vi.waitFor(() => expect(discarded).toHaveBeenCalledWith("lane-new"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(madeId);
    expect(await stage()).toBe("cancelled");
    moves.dispose();
  });

  it("refuses a bundle over 50 MiB before any part arrives", async () => {
    const { moves } = makeMoves();
    await offer(moves, "8");
    moves.respond({ moveId: moveId("8"), accept: true });
    const bytes = 50 * 1024 * 1024 + 1;
    const info = { bytes, sha256: "d".repeat(64), chunkCount: Math.ceil(bytes / (384 * 1024)), branchHeadSha: sha, snapshotSha: null, unpushedCommitCount: 1, changedFileCount: 1 };
    await expect(moves.guestCommand(guest(), { op: "begin", moveId: moveId("8"), payload: payload(moveId("8"), info) })).rejects.toThrow();
    moves.dispose();
  });
});
