import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import {
  createPluginPresenceService,
  MAX_PRESENCE_FANOUT_MACHINES,
  PLUGIN_MACHINE_UNREACHABLE_CODE,
  PLUGIN_PRESENCE_LIST_ACTION,
  PLUGIN_PRESENCE_SYNC_ACTION,
  type PluginPresenceDirectoryMachine,
} from "./pluginPresenceService";
import { readPluginPresenceForMachine, type PluginPresenceRow } from "./pluginTableWriters";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
}

function row(pluginId: string, version = "1.0.0"): PluginPresenceRow {
  return { pluginId, version, enabled: true, displayName: pluginId, icon: "", accent: "" };
}

function machine(machineKey: string, online = true): PluginPresenceDirectoryMachine {
  return { machineKey, label: machineKey, platform: "macOS", online };
}

describe("plugin presence fan-out", () => {
  let root: string;
  let db: AdeDb;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-presence-"));
    db = await openKvDb(path.join(root, ".ade", "kv.sqlite"), createLogger());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  type CallMachineMethod = (
    targetId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;

  function build(overrides: Partial<Parameters<typeof createPluginPresenceService>[0]> = {}) {
    const callMachineMethod = vi.fn<Parameters<CallMachineMethod>, Promise<unknown>>(
      async () => ({ plugins: [row("graph")] }),
    );
    const service = createPluginPresenceService({
      db,
      localMachineKey: () => "machine-self",
      listLocalPlugins: () => [row("local-plugin")],
      listMachines: async () => [machine("machine-a"), machine("machine-b")],
      resolveTargetIdForMachineKey: (key) => `target-${key}`,
      isTargetConnected: () => true,
      callMachineMethod: callMachineMethod as never,
      logger: { debug: () => {}, warn: () => {} },
      ...overrides,
    });
    return { service, callMachineMethod };
  }

  it("files each machine's rows under the key the DIRECTORY gave, not the one the payload claims", async () => {
    // The peer lies about who it is. Trusting the payload would let any machine
    // on the account overwrite any other machine's presence.
    const callMachineMethod = vi.fn(async (targetId: string) => ({
      machineKey: "machine-victim",
      plugins: [row(targetId === "target-machine-a" ? "graph" : "video")],
    }));
    const { service } = build({ callMachineMethod: callMachineMethod as never });

    const result = await service.refreshFromDirectory();

    expect(result.machinesContacted).toBe(2);
    expect(readPluginPresenceForMachine(db, "machine-a").map((entry) => entry.pluginId)).toEqual(["graph"]);
    expect(readPluginPresenceForMachine(db, "machine-b").map((entry) => entry.pluginId)).toEqual(["video"]);
    expect(readPluginPresenceForMachine(db, "machine-victim")).toEqual([]);
  });

  it("skips itself, offline machines, unpaired machines, and disconnected targets", async () => {
    const { service, callMachineMethod } = build({
      listMachines: async () => [
        machine("machine-self"),
        machine("machine-offline", false),
        machine("machine-unpaired"),
        machine("machine-disconnected"),
        machine("machine-ok"),
      ],
      resolveTargetIdForMachineKey: (key) => (key === "machine-unpaired" ? null : `target-${key}`),
      isTargetConnected: (targetId) => targetId !== "target-machine-disconnected",
    });

    const result = await service.refreshFromDirectory();

    // Calling a disconnected target spends its automatic-reconnect budget, and
    // exhausting that takes remote projects, lanes, and chat down with it.
    expect(result.machinesContacted).toBe(1);
    expect(callMachineMethod.mock.calls.map((call) => call[0])).toEqual(["target-machine-ok"]);
    expect(callMachineMethod.mock.calls[0][1]).toBe(PLUGIN_PRESENCE_LIST_ACTION);
  });

  it("applies the machine cap AFTER the reachability filters", async () => {
    // Unreachable machines at the head of the listing must not consume the
    // budget and starve out every machine the refresh could have reached.
    const machines = [
      ...Array.from({ length: 20 }, (_, index) => machine(`offline-${index}`, false)),
      ...Array.from({ length: 20 }, (_, index) => machine(`online-${index}`)),
    ];
    const { service, callMachineMethod } = build({ listMachines: async () => machines });

    const result = await service.refreshFromDirectory();

    expect(result.machinesContacted).toBe(MAX_PRESENCE_FANOUT_MACHINES);
    expect(callMachineMethod).toHaveBeenCalledTimes(MAX_PRESENCE_FANOUT_MACHINES);
    expect(callMachineMethod.mock.calls.every((call) => String(call[0]).startsWith("target-online-"))).toBe(true);
  });

  it("captures a per-machine failure without failing the sweep or dropping stored rows", async () => {
    const { service } = build();
    await service.refreshFromDirectory();
    expect(readPluginPresenceForMachine(db, "machine-a")).toHaveLength(1);

    const failing = build({
      callMachineMethod: (async (targetId: string) => {
        if (targetId === "target-machine-a") throw new Error("unreachable");
        return { plugins: [row("video")] };
      }) as never,
    });
    const result = await failing.service.refreshFromDirectory();

    expect(result.failures.map((failure) => failure.machineKey)).toEqual(["machine-a"]);
    expect(readPluginPresenceForMachine(db, "machine-b").map((entry) => entry.pluginId)).toEqual(["video"]);
    // "I could not ask" is not "it has no plugins" — the stored rows survive.
    expect(readPluginPresenceForMachine(db, "machine-a")).toHaveLength(1);
  });

  it("treats an unreadable answer from an older machine as a failure, not an empty install set", async () => {
    const { service } = build();
    await service.refreshFromDirectory();

    const older = build({ callMachineMethod: (async () => ({ ok: true })) as never });
    const result = await older.service.refreshFromDirectory();

    expect(result.failures).toHaveLength(2);
    expect(result.rowsWritten).toBe(0);
    expect(readPluginPresenceForMachine(db, "machine-a")).toHaveLength(1);
  });

  it("writes its own rows and nudges reachable machines when local install state changes", async () => {
    const { service, callMachineMethod } = build();

    await service.publishLocalPresence();

    expect(readPluginPresenceForMachine(db, "machine-self").map((entry) => entry.pluginId))
      .toEqual(["local-plugin"]);
    const nudges = callMachineMethod.mock.calls.filter((call) => call[1] === PLUGIN_PRESENCE_SYNC_ACTION);
    expect(nudges).toHaveLength(2);
    // The nudge carries no rows: it can only ask the peer to re-pull, which is
    // what makes a push safe when the receiver cannot verify who sent it.
    expect(nudges[0][2]).toEqual({});
  });

  it("collapses a nudge into a single debounced refresh", async () => {
    const { service, callMachineMethod } = build({ nudgeDebounceMs: 5 });

    service.onPeerPresenceChanged();
    service.onPeerPresenceChanged();
    service.onPeerPresenceChanged();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const lists = callMachineMethod.mock.calls.filter((call) => call[1] === PLUGIN_PRESENCE_LIST_ACTION);
    expect(lists).toHaveLength(2);
    service.dispose();
  });

  it("joins replicated rows with directory identity and marks this machine", async () => {
    const { service } = build();
    await service.publishLocalPresence();
    await service.refreshFromDirectory();

    const matrix = await service.readPresenceMatrix();

    expect(matrix.map((row) => [row.machineKey, row.isThisMachine, row.online])).toEqual([
      ["machine-a", false, true],
      ["machine-b", false, true],
      ["machine-self", true, true],
    ]);
    expect(matrix.find((row) => row.isThisMachine)?.pluginId).toBe("local-plugin");
    expect(matrix[0].machineName).toBe("machine-a");
  });

  it("still reports installs when the directory cannot be reached", async () => {
    const { service } = build();
    await service.publishLocalPresence();

    const offline = build({ listMachines: async () => { throw new Error("directory down"); } });
    const matrix = await offline.service.readPresenceMatrix();

    // The replicated rows are the truth about what is installed; only the names
    // and liveness come from the directory. Returning nothing here would read as
    // "no machine has any plugin".
    expect(matrix).toHaveLength(1);
    expect(matrix[0]).toMatchObject({
      machineKey: "machine-self",
      machineName: "machine-self",
      isThisMachine: true,
      // This machine is online by definition — it is the one answering.
      online: true,
    });
  });

  it("reports an empty version as null rather than an empty string", async () => {
    const { service } = build({ listLocalPlugins: () => [{ ...row("local-plugin"), version: "" }] });
    await service.publishLocalPresence();

    expect((await service.readPresenceMatrix())[0].version).toBeNull();
  });

  it("refuses to run a command on a machine it cannot reach", async () => {
    const unpaired = build({ resolveTargetIdForMachineKey: () => null });
    await expect(unpaired.service.callOnMachine("machine-b", "plugins.install"))
      .rejects.toMatchObject({ code: PLUGIN_MACHINE_UNREACHABLE_CODE });

    const disconnected = build({ isTargetConnected: () => false });
    await expect(disconnected.service.callOnMachine("machine-b", "plugins.install"))
      .rejects.toMatchObject({ code: PLUGIN_MACHINE_UNREACHABLE_CODE });

    // Never a silent local fallback: running the command here would install a
    // plugin on the wrong computer while reporting success.
    const reachable = build();
    await reachable.service.callOnMachine("machine-b", "plugins.install", { kind: "git", url: "u" });
    expect(reachable.callMachineMethod.mock.calls[0][0]).toBe("target-machine-b");
    expect(reachable.callMachineMethod.mock.calls[0][2]).toEqual({ kind: "git", url: "u" });
  });
});
