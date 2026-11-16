import { describe, expect, it, vi } from "vitest";
import { createMachineConnector, type MachineConnectorDeps } from "./machineConnector";

/**
 * A computer of the account: saved connections, the account's list, pairing,
 * connect and wake are this computer's boundaries (the remote-runtime pool,
 * the account directory), so each one is a fake that records what it was asked.
 */
function harness(options: { saved?: Record<string, string>; declined?: string[] } = {}) {
  const saved = new Map(Object.entries(options.saved ?? {}));
  const connected = new Set<string>();
  const declined = new Set(options.declined ?? []);
  const deps = {
    localMachineKey: () => "this-mac",
    signedIn: () => true,
    savedTarget: (machineKey: string) => {
      const id = saved.get(machineKey);
      return id ? { id, name: `Saved ${machineKey}` } : null;
    },
    isConnected: (targetId: string) => connected.has(targetId),
    declined: (targetId: string) => declined.has(targetId),
    accountMachine: vi.fn(async (machineKey: string) => ({ name: `Account ${machineKey}` })),
    pairMachine: vi.fn(async (machineKey: string) => {
      const targetId = `target-${machineKey}`;
      saved.set(machineKey, targetId);
      return { targetId, name: `Paired ${machineKey}` };
    }),
    connect: vi.fn(async (targetId: string, _options?: { background?: boolean }) => {
      connected.add(targetId);
    }),
    wake: vi.fn(async () => ({ state: "awake" as const })),
  } satisfies MachineConnectorDeps;
  return { deps, connector: createMachineConnector(deps), connected, declined };
}

describe("createMachineConnector", () => {
  it("never wakes a computer or overrides a Disconnect for a background connect; a person's connect does both", async () => {
    const { deps, connector, connected } = harness({ saved: { studio: "target-studio" }, declined: ["target-studio"] });

    // A computer the person disconnected stays off, and nothing is dialed.
    await expect(connector.connect("studio", { background: true })).resolves.toMatchObject({
      ok: false,
      reason: "declined",
    });
    expect(deps.connect).not.toHaveBeenCalled();

    // A computer never saved here is paired and connected without a wake,
    // and the connect says nobody asked.
    await expect(connector.connect("cloud-1", { background: true })).resolves.toMatchObject({
      ok: true,
      address: { kind: "remote", targetId: "target-cloud-1" },
    });
    expect(deps.wake).not.toHaveBeenCalled();
    expect(deps.connect).toHaveBeenLastCalledWith("target-cloud-1", { background: true });

    // The person connects both: the Disconnect is theirs to lift, and a new
    // pairing may wake a sleeping cloud computer first.
    await expect(connector.connect("studio")).resolves.toMatchObject({ ok: true });
    expect(deps.connect).toHaveBeenLastCalledWith("target-studio", { background: false });
    await expect(connector.connect("cloud-2")).resolves.toMatchObject({ ok: true });
    expect(deps.wake).toHaveBeenCalledWith("cloud-2");
    expect([...connected].sort()).toEqual(["target-cloud-1", "target-cloud-2", "target-studio"]);
  });

  it("runs a person's connect after a background flight for the same computer instead of taking its answer", async () => {
    const { deps, connector } = harness({ saved: { studio: "target-studio" } });
    let finishDial!: () => void;
    // The background flight fails (its answer is about a connect nobody asked for).
    deps.connect.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishDial = resolve; });
      throw new Error("The background dial was stopped.");
    });

    const background = connector.connect("studio", { background: true });
    const asked = connector.connect("studio");
    await vi.waitFor(() => expect(deps.connect).toHaveBeenCalledTimes(1));
    finishDial();

    await expect(background).resolves.toMatchObject({ ok: false, reason: "unreachable" });
    // The person's own connect ran after it, with its own options, and joined.
    await expect(asked).resolves.toMatchObject({ ok: true, address: { targetId: "target-studio" } });
    expect(deps.connect).toHaveBeenCalledTimes(2);
    expect(deps.connect).toHaveBeenLastCalledWith("target-studio", { background: false });
  });
});
