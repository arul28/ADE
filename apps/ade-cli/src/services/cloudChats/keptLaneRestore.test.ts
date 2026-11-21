import { describe, expect, it } from "vitest";
import { CloudApiError } from "../../../../desktop/src/shared/cloudApiClient";
import { createKeptLaneRestores, type KeptLaneRestoreProject } from "./keptLaneRestore";

/**
 * A kept ADE Cloud lane moved to the person's own machine. The account server
 * is faked (the network boundary) with the state the real one keeps: saved
 * copies by machine key, a move that re-keys one, and the kept-lane record.
 * The contract is the order: the record is forgotten only after the lane and
 * every chat are here; a failed chat leaves it; a new start goes on. A move
 * from an asleep computer deletes it first, only through the server's
 * "only if saved" delete; a refusal deletes nothing and asks for a wake.
 */
describe("kept lane restore", () => {
  const LANE = "lane-1";
  const MINE = "key-mac";
  const kept = {
    laneId: LANE, laneName: "Fix the login page", projectOrigin: "https://github.com/acme/widgets.git", branchRef: "ade/fix-login",
    reason: "idle_cleanup", type: "default", cpu: 2, memory_gb: 4, formerInstanceId: "abcde12345", formerMachineKey: "key-old", since: 1,
  };

  /** The lane's computer is still there, asleep: `saved` is its last rest save; `refuse` is the server's 409 code at the delete. */
  type Asleep = { saved: boolean; refuse?: string };
  const setup = (options: { laneFails?: boolean; chatFailsOnce?: string; alsoOnAnotherMachine?: boolean; asleep?: Asleep } = {}) => {
    const steps: string[] = [];
    const here = new Set<string>();
    const asleep = options.asleep ?? null;
    let keptOnServer = !asleep;
    let computerDeleted = false;
    let failing = options.chatFailsOnce ?? null;
    // Saved copies by `machineKey/chatId`, as the server files them.
    // `key-desk` is another machine of the person's (no computer): a move there that didn't finish.
    const copies = new Map<string, number>([["key-old/c1", 20], ["key-old/c2", 10], ...(options.alsoOnAnotherMachine ? [["key-desk/c3", 5] as [string, number]] : [])]);
    const row = (key: string) => {
      const [machineKey, chatId] = key.split("/") as [string, string];
      return {
        machineKey, chatId, laneId: LANE, title: chatId, provider: "claude", model: "claude-sonnet", lastSeq: 1, updatedAt: copies.get(key)!,
        computer: machineKey === "key-old" ? { state: "deleted", deletedAt: 1, reason: "idle" } : null,
      };
    };
    const api = {
      computer: async (instanceId: string) => ({
        id: instanceId, status: "sleeping", type: "default", resources: { cpu: 2, memory: 4 },
        backups: { saved: asleep?.saved === true, problems: [] },
        metadata: {
          ade_lane_id: LANE, ade_lane_name: kept.laneName, ade_project_origin: "github.com/acme/widgets",
          ade_lane_branch: kept.branchRef, ade_machine_key: kept.formerMachineKey,
        },
      }),
      deleteComputer: async (instanceId: string, args: { keepLane?: { branchRef: string | null; onlyIfSaved?: boolean } }) => {
        steps.push(`release ${instanceId}${args.keepLane?.onlyIfSaved ? " only if saved" : ""}`);
        if (asleep?.refuse) throw new CloudApiError("The ADE Cloud computer is awake, so its saved copy may be older than its work.", asleep.refuse, 409);
        computerDeleted = true;
        keptOnServer = true;
        return {};
      },
      lanesWithoutComputer: async () => (keptOnServer ? [kept] : []),
      laneBackups: async () => [],
      savedChats: async () => ({ chats: [...copies.keys()].map(row), nextCursor: null }),
      savedSessions: async () => ({ sessions: [], nextCursor: null }),
      savedChat: async ({ machineKey, chatId }: { machineKey: string; chatId: string }) => (copies.has(`${machineKey}/${chatId}`)
        ? { chat: row(`${machineKey}/${chatId}`), parts: [{ seq: 1, text: "" }], hasMore: false, nextBefore: null }
        : null),
      capsuleManifest: async () => null,
      moveSavedChat: async (from: string, chatId: string, move: { toMachineKey: string; instanceId?: string }) => {
        steps.push(`move ${chatId}${move.instanceId ? " by a computer" : ""}`);
        const updatedAt = copies.get(`${from}/${chatId}`)!;
        copies.delete(`${from}/${chatId}`);
        copies.set(`${move.toMachineKey}/${chatId}`, updatedAt);
        return { moved: true, chat: { lastSeq: 1 } };
      },
      forgetMovedLaneWithoutComputer: async (laneId: string, moved: { toMachineKey: string; keepBackups: boolean }) => {
        steps.push(`forget ${laneId} keeping ${moved.toMachineKey}`);
        keptOnServer = false;
        return { forgotten: true };
      },
    };
    const project: KeptLaneRestoreProject = {
      projectRoot: "/work/widgets",
      originUrl: "git@github.com:acme/widgets.git",
      restoreLane: async () => {
        steps.push("lane");
        if (options.laneFails) throw new Error("This computer can't get the commits the lane's saved work builds on from GitHub.");
        return { localLaneId: LANE, keepBackups: false };
      },
      hasSession: async (sessionId) => here.has(sessionId),
      restore: async (args) => {
        if (failing === args.sessionId) {
          failing = null;
          throw new Error("This chat's model 'claude-sonnet' is not available on this computer.");
        }
        steps.push(`restore ${args.sessionId}`);
        here.add(args.sessionId);
        return { sessionId: args.sessionId, restoredWith: "replay" };
      },
      restoreCli: async () => {
        throw new Error("no CLI in this lane");
      },
      adopt: async () => false,
      hold: () => {},
      release: () => {},
    };
    const store = createKeptLaneRestores({
      api: async () => api as never,
      machineKey: () => MINE,
      logger: { info: () => {}, warn: () => {} },
    });
    // The job runs on after `start` answers; every fake answers at once, so a few turns of the loop end it.
    const finished = async (restoreId: string) => {
      for (let turn = 0; turn < 200 && store.get({ restoreId })?.state === "running"; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return store.get({ restoreId })!;
    };
    return { steps, store, project, finished, keptOnServer: () => keptOnServer, computerDeleted: () => computerDeleted };
  };

  it("forgets the kept lane only after the lane and every chat are here; a failed chat keeps it and a new start goes on", async () => {
    const { steps, store, project, finished, keptOnServer } = setup({ chatFailsOnce: "c2" });
    // Two starts at once are one restore.
    const [first, again] = await Promise.all([store.start(project, { laneId: LANE }), store.start(project, { laneId: LANE })]);
    expect([first.state, again.restoreId]).toEqual(["running", first.restoreId]);

    const failed = await finished(first.restoreId);
    expect(failed).toMatchObject({ state: "failed", step: "chats", localLaneId: LANE });
    expect(failed.chats.map((chat) => [chat.chatId, chat.state])).toEqual([["c1", "restored"], ["c2", "failed"]]);
    // Each copy moved (as the person's machine, with no computer id) before its chat restored; nothing was forgotten.
    expect(steps).toEqual(["lane", "move c1", "restore c1", "move c2"]);
    expect(keptOnServer()).toBe(true);

    steps.length = 0;
    const retry = await finished((await store.start(project, { laneId: LANE })).restoreId);
    expect(retry).toMatchObject({ state: "completed", step: "done", error: null });
    // c1 is here already; c2's copy is under this machine's key already: it restores with no second move.
    expect(steps).toEqual(["lane", "restore c2", `forget ${LANE} keeping key-mac`]);
    expect(retry.chats.map((chat) => [chat.chatId, chat.state])).toEqual([["c1", "restored"], ["c2", "restored"]]);
  });

  it("keeps the kept lane while one of its chats sits on another machine of the person's: the forget would delete that copy", async () => {
    const { steps, store, project, finished, keptOnServer } = setup({ alsoOnAnotherMachine: true });
    const record = await finished((await store.start(project, { laneId: LANE })).restoreId);
    expect(record.state).toBe("failed");
    expect(record.chats.map((chat) => [chat.chatId, chat.state])).toEqual([["c1", "restored"], ["c2", "restored"], ["c3", "failed"]]);
    expect([steps.filter((step) => step.startsWith("forget")), keptOnServer()]).toEqual([[], true]);
  });

  it("restores no chat and forgets nothing when the lane can't come in", async () => {
    const { steps, store, project, finished, keptOnServer } = setup({ laneFails: true });
    const record = await finished((await store.start(project, { laneId: LANE })).restoreId);
    expect(record).toMatchObject({ state: "failed", step: "lane", localLaneId: null, chats: [] });
    expect(record.error).toContain("can't get the commits");
    expect([steps, keptOnServer()]).toEqual([["lane"], true]);
  });

  it("a move from an asleep computer deletes it first, only if saved, then restores from the kept lane", async () => {
    const { steps, store, project, finished, keptOnServer, computerDeleted } = setup({ asleep: { saved: true } });
    const started = await store.start(project, { laneId: LANE, fromComputer: { instanceId: kept.formerInstanceId } });
    expect(started.step).toBe("release");

    const record = await finished(started.restoreId);
    expect(record).toMatchObject({ state: "completed", step: "done", localLaneId: LANE });
    expect(record.wakeInstead).toBeFalsy();
    expect(steps).toEqual([
      `release ${kept.formerInstanceId} only if saved`, "lane", "move c1", "restore c1", "move c2", "restore c2", `forget ${LANE} keeping key-mac`,
    ]);
    expect([computerDeleted(), keptOnServer()]).toEqual([true, false]);
  });

  it.each(["computer_awake", "backup_not_current"])("deletes nothing and asks for a wake when the server refuses the delete: %s", async (refuse) => {
    const { steps, store, project, finished, computerDeleted } = setup({ asleep: { saved: true, refuse } });
    const record = await finished((await store.start(project, { laneId: LANE, fromComputer: { instanceId: kept.formerInstanceId } })).restoreId);
    expect(record).toMatchObject({ state: "failed", step: "release", wakeInstead: true, localLaneId: null, chats: [] });
    expect([steps, computerDeleted()]).toEqual([[`release ${kept.formerInstanceId} only if saved`], false]);
  });

  it("refuses to start from an asleep computer whose last save isn't complete, and deletes nothing", async () => {
    const { steps, store, project, computerDeleted } = setup({ asleep: { saved: false } });
    await expect(store.start(project, { laneId: LANE, fromComputer: { instanceId: kept.formerInstanceId } })).rejects.toThrow();
    expect([steps, computerDeleted()]).toEqual([[], false]);
  });
});
