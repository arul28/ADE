import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createLaneShareRightsStore, ensureLaneShareRightsSchema } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import { laneSharePresetRights, type LaneShareRights } from "../../../../desktop/src/shared/laneShareRights";
import { createLaneShareHostService } from "./laneShareHostService";

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
