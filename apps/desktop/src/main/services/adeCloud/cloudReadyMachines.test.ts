import { describe, expect, it } from "vitest";
import type { CloudAccountState } from "../../../shared/adeCloud";
import { CLOUD_READY_METADATA, type CloudReadyProjectSettings } from "../../../shared/cloudReady";
import { createCloudServerProvider } from "./cloudServerProvider";
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import { claimCloudReadyMachine, releaseCloudReadyMachine } from "./cloudReadyClaim";
import { createCloudReadyKeeper } from "./cloudReadyMachines";

/**
 * Ready machines bill while awake and are someone's machine once claimed.
 * These pin the two ways that goes wrong: a pass that deletes or sleeps a
 * machine it must not (a claimed one, another computer's on a choice read
 * from this computer alone, a newer one), and a release that sleeps a
 * machine another caller claimed. Only the provider's HTTP API is a stand-in.
 */

const PROJECT = "github.com/acme/app";
const OTHER = "github.com/acme/other";
const ME = "this-copy";

type FakeBox = { id: string; status: string; metadata: Record<string, string> };

function fakeCloud(initial: FakeBox[]) {
  const boxes = new Map(initial.map((box) => [box.id, { ...box, metadata: { ...box.metadata } }]));
  const slept: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const route = url.slice("https://directory.invalid/cloud".length);
    if (route === "/instances" && method === "GET") return json(200, { data: [...boxes.values()] });
    const action = /^\/instances\/([^/]+)\/(sleep|start)$/.exec(route);
    if (action) {
      const box = boxes.get(action[1]!);
      if (!box) return json(404, { error: { code: "not_found", message: "gone" } });
      box.status = action[2] === "sleep" ? "sleeping" : "running";
      if (action[2] === "sleep") slept.push(box.id);
      return json(200, { status: box.status });
    }
    const metadata = /^\/instances\/([^/]+)\/metadata$/.exec(route);
    if (metadata && method === "PUT") {
      const box = boxes.get(metadata[1]!);
      if (!box) return json(404, { error: { code: "not_found", message: "gone" } });
      box.metadata = { ...(JSON.parse(String(init?.body)) as { metadata: Record<string, string> }).metadata };
      return json(200, { ok: true });
    }
    const one = /^\/instances\/([^/]+)$/.exec(route);
    if (one) {
      const box = boxes.get(one[1]!);
      if (!box) return json(404, { error: { code: "not_found", message: "gone" } });
      if (method === "DELETE") {
        boxes.delete(box.id);
        return new Response(null, { status: 204 });
      }
      return json(200, box);
    }
    return json(500, { error: { code: "internal_error", message: `no route ${method} ${route}` } });
  };
  return {
    client: createCloudServerProvider({ accessToken: async () => "account-token", baseUrl: () => "https://directory.invalid", fetch }),
    boxes,
    slept,
  };
}

function readyBox(id: string, extra: Record<string, string> = {}, status = "sleeping"): FakeBox {
  return {
    id,
    status,
    metadata: {
      [CLOUD_READY_METADATA.project]: PROJECT,
      [CLOUD_READY_METADATA.state]: "ready",
      [CLOUD_MACHINE_KEY_METADATA]: `key-${id}`,
      ...extra,
    },
  };
}

const keptReady: CloudReadyProjectSettings = {
  identity: PROJECT,
  projectName: "app",
  kind: "vm",
  shape: "4x8",
  setup: "",
  failure: null,
};

describe("ready machine keeper", () => {
  it.each([
    { authoritative: true, deletesOtherComputersUnwanted: true },
    { authoritative: false, deletesOtherComputersUnwanted: false },
  ])("a pass deletes only what should go (account answered: $authoritative)", async ({ authoritative, deletesOtherComputersUnwanted }) => {
    const fake = fakeCloud([
      readyBox("keep01", { [CLOUD_READY_METADATA.adeVersion]: "1.2.129" }),
      readyBox("newer01", { [CLOUD_READY_METADATA.adeVersion]: "1.2.130" }),
      readyBox("older01", { [CLOUD_READY_METADATA.adeVersion]: "1.2.128" }),
      readyBox("broken01", {}, "failed"),
      readyBox("awake01", { [CLOUD_READY_METADATA.adeVersion]: "1.2.129" }, "running"),
      // Turned off on the account: another computer's, this copy's, and one somebody claimed.
      readyBox("theirs01", { [CLOUD_READY_METADATA.project]: OTHER, [CLOUD_READY_METADATA.preparedBy]: "other-copy" }),
      readyBox("mine0001", { [CLOUD_READY_METADATA.project]: OTHER, [CLOUD_READY_METADATA.preparedBy]: ME }),
      readyBox("claimed1", { [CLOUD_READY_METADATA.project]: OTHER, [CLOUD_READY_METADATA.state]: "claimed" }, "running"),
    ]);
    const removedRows: string[] = [];
    const keeper = createCloudReadyKeeper({
      client: async () => fake.client,
      settings: { read: async () => ({ projects: [keptReady], authoritative }), write: async () => undefined },
      createMachine: async () => {
        throw new Error("the pool is not empty; nothing should be made");
      },
      removeAccountMachine: async (machineKey) => {
        removedRows.push(machineKey);
      },
      preparerId: ME,
      currentAdeVersion: () => "1.2.129",
      sleep: async () => undefined,
    });

    const status = await keeper.refresh();
    keeper.stop();

    const left = [...fake.boxes.keys()].sort();
    const expected = ["awake01", "claimed1", "keep01", "newer01", ...(deletesOtherComputersUnwanted ? [] : ["theirs01"])].sort();
    expect(left).toEqual(expected);
    // A deleted machine's account row goes with it; a kept one's stays.
    expect(removedRows.sort()).toEqual(
      ["key-broken01", "key-mine0001", "key-older01", ...(deletesOtherComputersUnwanted ? ["key-theirs01"] : [])].sort(),
    );
    // A ready machine left awake is put back to sleep; a claimed one is the person's and stays awake.
    expect(fake.slept).toEqual(["awake01"]);
    expect(fake.boxes.get("claimed1")?.status).toBe("running");
    expect(status.projects.map((project) => project.state)).toEqual(["ready"]);
  });

  it("gives a claim back only to the claim that took it, and never hands out a machine ADE can't name", async () => {
    const fake = fakeCloud([
      { ...readyBox("nokey001"), metadata: { [CLOUD_READY_METADATA.project]: PROJECT, [CLOUD_READY_METADATA.state]: "ready" } },
      readyBox("good0001"),
    ]);

    const claim = await claimCloudReadyMachine(fake.client, PROJECT);

    expect(claim.instanceId).toBe("good0001");
    expect(claim.machineKey).toBe("key-good0001");
    expect(fake.boxes.get("good0001")?.status).toBe("running");
    // The machine with no ADE machine recorded is tagged failed (the keeper deletes it), not handed out.
    expect(fake.boxes.get("nokey001")?.metadata[CLOUD_READY_METADATA.state]).toBe("failed");

    expect(await releaseCloudReadyMachine(fake.client, "good0001", "another-callers-token")).toBe(false);
    expect(fake.boxes.get("good0001")?.metadata[CLOUD_READY_METADATA.state]).toBe("claimed");
    expect(fake.slept).toEqual([]);

    expect(await releaseCloudReadyMachine(fake.client, "good0001", claim.claimToken)).toBe(true);
    expect(fake.boxes.get("good0001")?.metadata[CLOUD_READY_METADATA.state]).toBe("ready");
    expect(fake.slept).toEqual(["good0001"]);
  });

  it.each([
    { month: "out of hours", error: /out of ADE Cloud hours/i },
    { month: "unreadable", error: /couldn't read your ADE Cloud hours/i },
  ] as const)("with hours $month makes no ready machine, until it can", async ({ month, error }) => {
    const fake = fakeCloud([readyBox("other001", { [CLOUD_READY_METADATA.project]: OTHER })]);
    let blocked = true;
    const account = async () => {
      if (blocked && month === "unreadable") throw new Error("ADE Cloud account read timed out");
      return { hours: { state: blocked ? "zero" : "none" } } as unknown as CloudAccountState;
    };
    const made: string[] = [];
    let prepareStarted!: () => void;
    const started = new Promise<void>((resolve) => { prepareStarted = resolve; });
    const keeper = createCloudReadyKeeper({
      client: async () => fake.client,
      settings: { read: async () => ({ projects: [keptReady], authoritative: false }), write: async () => undefined },
      createMachine: async (requestId) => {
        made.push(requestId);
        prepareStarted();
        throw new Error("stop here: the test only needs to see the prepare start");
      },
      removeAccountMachine: async () => undefined,
      preparerId: ME,
      account,
      sleep: async () => undefined,
    });

    const held = await keeper.refresh();
    expect(made).toEqual([]);
    expect(held.error).toMatch(error);
    blocked = false;
    const cleared = await keeper.refresh();
    await started;
    keeper.stop();
    expect(made).toHaveLength(1);
    expect(cleared.error).toBeNull();
  });
});
