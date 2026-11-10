import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  laneSharePresetRights,
  laneShareRiskLevel,
  parseLaneShareRights,
  type LaneShareRights,
} from "../../../shared/laneShareRights";
import { createLaneShareRightsStore, ensureLaneShareRightsSchema } from "./laneShareRightsStore";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncType };

const GRANT = `ls_${"a".repeat(32)}`;

/** A real SQLite database, as the brain's project database is. */
function openDb(sqlite: DatabaseSyncType = new DatabaseSync(":memory:")) {
  const db = {
    run: (sql: string, params: unknown[] = []) => {
      sqlite.prepare(sql).run(...(params as never[]));
    },
    get: <T,>(sql: string, params: unknown[] = []) => (sqlite.prepare(sql).get(...(params as never[])) ?? null) as T | null,
    all: <T,>(sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...(params as never[])) as T[],
  };
  ensureLaneShareRightsSchema(db);
  db.run("create table if not exists lanes (id text primary key, archived_at text)");
  return { db: db as never, sqlite };
}

function withLimits(limits: Partial<LaneShareRights["limits"]>): LaneShareRights {
  const rights = laneSharePresetRights("collaborate");
  rights.limits = { ...rights.limits, ...limits };
  return rights;
}

describe("lane share rights", () => {
  it.each<[string, unknown]>([
    ["a key from a newer version", { version: 2, see: { chats: true, screens: true }, speak: { sendVoice: true }, newGroup: { all: true } }],
    ["a truthy value that is not exactly true", { see: { chats: 1, shells: "yes" }, speak: { send: "true", interruptAnyTurn: 1 }, decide: { approvals: {} } }],
    ["a list of unknown permission modes", { run: { permissionModes: ["yolo", "default "] } }],
    ["not an object", "collaborate"],
  ])("turns %s off", (_label, input) => {
    const rights = parseLaneShareRights(input);
    expect(rights.speak.send).toBe(false);
    expect(rights.speak.interruptAnyTurn).toBe(false);
    expect(rights.decide.approvals).toBe(false);
    expect(rights.see.shells).toBe(false);
    expect(rights.run.permissionModes.filter((mode) => mode !== "default")).toEqual([]);
    expect(rights).not.toHaveProperty("newGroup");
    expect(rights.see).not.toHaveProperty("screens");
    expect(rights.version).toBe(1);
  });

  // The words the confirm dialog must carry: the agent reads beyond the lane
  // whenever turns are allowed, and turns with no limit spend the owner's sign-ins.
  const agentReach = /files on this computer/i;
  const noLimit = /no message limit/i;
  const interruptAny = /stop or steer/i;
  it.each<[string, (rights: LaneShareRights) => void, "low" | "medium" | "high", RegExp[], RegExp[]]>([
    ["Watch", () => {}, "low", [], [agentReach, noLimit]],
    ["Collaborate (ask-first modes, daily limit)", (rights) => Object.assign(rights, laneSharePresetRights("collaborate")), "medium", [agentReach], [noLimit]],
    ["Collaborate with no limit", (rights) => {
      Object.assign(rights, laneSharePresetRights("collaborate"));
      rights.limits.messagesPerDay = null;
    }, "medium", [agentReach, noLimit], []],
    ["Collaborate with only a total limit", (rights) => {
      Object.assign(rights, laneSharePresetRights("collaborate"));
      rights.limits = { ...rights.limits, messagesPerDay: null, messagesTotal: 10 };
    }, "medium", [agentReach], [noLimit]],
    ["stopping anyone's turn", (rights) => {
      rights.speak.interruptAnyTurn = true;
    }, "medium", [interruptAny], [agentReach]],
    ["turns with no permission lock", (rights) => {
      rights.speak.send = true;
    }, "high", [agentReach, noLimit], []],
    ["approvals", (rights) => {
      rights.decide.approvals = true;
    }, "high", [], [agentReach]],
    ["typing into CLI sessions", (rights) => {
      rights.run.typeInCliSessions = true;
    }, "high", [agentReach], []],
    ["file reads", (rights) => {
      rights.tools.file = true;
    }, "medium", [], [agentReach]],
  ])("rates %s", (_label, change, level, says, doesNotSay) => {
    const rights = laneSharePresetRights("watch");
    change(rights);
    const risk = laneShareRiskLevel(rights);
    expect(risk.level).toBe(level);
    for (const words of says) expect(risk.reasons.some((reason) => words.test(reason)), String(words)).toBe(true);
    for (const words of doesNotSay) expect(risk.reasons.some((reason) => words.test(reason)), String(words)).toBe(false);
  });
});

describe("lane share rights store", () => {
  it("keeps rights and counters across a restart, and drops them with the grant", () => {
    const { db, sqlite } = openDb();
    const first = createLaneShareRightsStore({ db, now: () => Date.UTC(2026, 10, 10, 12) });
    first.put({ grantId: GRANT, laneId: "lane-1", receiverEmail: "guest@example.com", rights: withLimits({ messagesTotal: 5 }) });
    expect(first.claimMessage(GRANT).ok).toBe(true);
    first.addItem(GRANT, "draft", "draft-1", null);

    const reopened = createLaneShareRightsStore({ db: openDb(sqlite).db, now: () => Date.UTC(2026, 10, 10, 13) });
    expect(reopened.get(GRANT)).toMatchObject({ laneId: "lane-1", rights: { speak: { send: true } }, usage: { total: 1 } });
    expect(reopened.usage(GRANT).messagesLeftTotal).toBe(4);
    expect(reopened.hasItem(GRANT, "draft", "draft-1")).toBe(true);

    reopened.delete(GRANT);
    expect(reopened.get(GRANT)).toBeNull();
    expect(reopened.hasItem(GRANT, "draft", "draft-1")).toBe(false);
  });

  it("refuses message N+1 against the total and gives back a refunded claim", () => {
    const { db } = openDb();
    const store = createLaneShareRightsStore({ db, now: () => Date.UTC(2026, 10, 10, 12) });
    store.put({ grantId: GRANT, laneId: "lane-1", rights: withLimits({ messagesTotal: 2 }) });
    const first = store.claimMessage(GRANT);
    expect(first.ok).toBe(true);
    if (first.ok) store.refundMessage(first.claim);
    expect(store.claimMessage(GRANT).ok).toBe(true);
    expect(store.claimMessage(GRANT).ok).toBe(true);
    expect(store.claimMessage(GRANT)).toMatchObject({ ok: false, refusal: { code: "lane_share_total_limit", resetAt: null } });
  });

  it("refuses a grant this host holds no rights for", () => {
    const store = createLaneShareRightsStore({ db: openDb().db });
    expect(store.claimMessage(GRANT).ok).toBe(false);
  });

  // The day rule: the host's local calendar day in its own time zone. The
  // count starts again only when the local date moves FORWARD past the stored
  // day; a clock set back keeps the count of the later day it already holds.
  it.each<[string, string, number, number, number, boolean]>([
    // tz, first claim (UTC ms), second claim, expected reset (UTC ms), whether the second is allowed
    ["UTC, the next day", "UTC", Date.UTC(2026, 10, 10, 23, 30), Date.UTC(2026, 10, 11, 0, 1), Date.UTC(2026, 10, 11), true],
    ["UTC, the same day", "UTC", Date.UTC(2026, 10, 10, 0, 30), Date.UTC(2026, 10, 10, 23, 59), Date.UTC(2026, 10, 11), false],
    // 23:30 UTC on 10 Nov is 18:30 in New York: still 10 Nov there, so no reset at UTC midnight.
    ["New York, past UTC midnight", "America/New_York", Date.UTC(2026, 10, 10, 20), Date.UTC(2026, 10, 11, 1), Date.UTC(2026, 10, 11, 5), false],
    ["New York, past local midnight", "America/New_York", Date.UTC(2026, 10, 10, 20), Date.UTC(2026, 10, 11, 5, 1), Date.UTC(2026, 10, 11, 5), true],
    ["a clock set back a day", "UTC", Date.UTC(2026, 10, 10, 12), Date.UTC(2026, 10, 9, 12), Date.UTC(2026, 10, 11), false],
  ])("counts one message a day by the host's local date: %s", (_label, timeZone, firstAt, secondAt, resetAt, allowed) => {
    let at = firstAt;
    const store = createLaneShareRightsStore({ db: openDb().db, now: () => at, timeZone });
    store.put({ grantId: GRANT, laneId: "lane-1", rights: withLimits({ messagesPerDay: 1 }) });
    expect(store.claimMessage(GRANT).ok).toBe(true);
    at = secondAt;
    const second = store.claimMessage(GRANT);
    expect(second.ok).toBe(allowed);
    if (!second.ok) {
      expect(second.refusal).toMatchObject({ code: "lane_share_daily_limit", resetAt });
      expect(store.usage(GRANT)).toMatchObject({ messagesLeftToday: 0, dailyResetAt: resetAt });
    }
  });

  it.each<[string | null, "active" | "archived" | "missing"]>([
    [null, "active"],
    ["2026-11-10T12:00:00.000Z", "archived"],
  ])("reads a lane archived at %s as %s, and a deleted lane as missing", (archivedAt, state) => {
    const { db } = openDb();
    (db as { run: (sql: string, params: unknown[]) => void }).run("insert into lanes (id, archived_at) values (?, ?)", ["lane-1", archivedAt]);
    const store = createLaneShareRightsStore({ db });
    expect(store.laneState("lane-1")).toBe(state);
    expect(store.laneState("lane-gone")).toBe("missing");
  });
});
