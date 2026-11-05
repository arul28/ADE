import { describe, expect, it } from "vitest";
import { AGENT37_API_BASE_URL, AGENT37_READY_METADATA, type Agent37ReadyProjectSettings } from "../../../shared/agent37";
import { createAgent37Client } from "./agent37Client";
import { AGENT37_MACHINE_KEY_METADATA } from "./agent37Machines";
import { claimAgent37ReadyMachine, releaseAgent37ReadyMachine } from "./agent37ReadyClaim";
import { createAgent37ReadyKeeper } from "./agent37ReadyMachines";

/**
 * Ready machines bill while awake and are someone's machine once claimed.
 * These pin the two ways that goes wrong: a pass that deletes or sleeps a
 * machine it must not (a claimed one, another computer's on a choice read
 * from this computer alone, a newer one), and a release that sleeps a
 * machine another caller claimed. Only Agent 37's HTTP API is a stand-in.
 */

const PROJECT = "github.com/acme/app";
const OTHER = "github.com/acme/other";
const ME = "this-copy";

type FakeBox = { id: string; status: string; metadata: Record<string, string> };

function fakeAgent37(initial: FakeBox[]) {
  const boxes = new Map(initial.map((box) => [box.id, { ...box, metadata: { ...box.metadata } }]));
  const slept: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const route = url.slice(AGENT37_API_BASE_URL.length);
    if (route === "/instances" && method === "GET") return json(200, { data: [...boxes.values()] });
    const action = /^\/instances\/([^/]+)\/(sleep|start)$/.exec(route);
    if (action) {
      const box = boxes.get(action[1]!);
      if (!box) return json(404, { error: { code: "not_found", message: "gone" } });
      box.status = action[2] === "sleep" ? "sleeping" : "running";
      if (action[2] === "sleep") slept.push(box.id);
      return json(200, { status: box.status });
    }
    const one = /^\/instances\/([^/]+)$/.exec(route);
    if (one) {
      const box = boxes.get(one[1]!);
      if (!box) return json(404, { error: { code: "not_found", message: "gone" } });
      if (method === "DELETE") {
        boxes.delete(box.id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        box.metadata = { ...(JSON.parse(String(init?.body)) as { metadata: Record<string, string> }).metadata };
        return json(200, box);
      }
      return json(200, box);
    }
    return json(500, { error: { code: "internal_error", message: `no route ${method} ${route}` } });
  };
  return { client: createAgent37Client({ apiKey: "sk_test", fetch }), boxes, slept };
}

function readyBox(id: string, extra: Record<string, string> = {}, status = "sleeping"): FakeBox {
  return {
    id,
    status,
    metadata: {
      [AGENT37_READY_METADATA.project]: PROJECT,
      [AGENT37_READY_METADATA.state]: "ready",
      [AGENT37_MACHINE_KEY_METADATA]: `key-${id}`,
      ...extra,
    },
  };
}

const keptReady: Agent37ReadyProjectSettings = {
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
    const fake = fakeAgent37([
      readyBox("keep01", { [AGENT37_READY_METADATA.adeVersion]: "1.2.129" }),
      readyBox("newer01", { [AGENT37_READY_METADATA.adeVersion]: "1.2.130" }),
      readyBox("older01", { [AGENT37_READY_METADATA.adeVersion]: "1.2.128" }),
      readyBox("broken01", {}, "failed"),
      readyBox("awake01", { [AGENT37_READY_METADATA.adeVersion]: "1.2.129" }, "running"),
      // Turned off on the account: another computer's, this copy's, and one somebody claimed.
      readyBox("theirs01", { [AGENT37_READY_METADATA.project]: OTHER, [AGENT37_READY_METADATA.preparedBy]: "other-copy" }),
      readyBox("mine0001", { [AGENT37_READY_METADATA.project]: OTHER, [AGENT37_READY_METADATA.preparedBy]: ME }),
      readyBox("claimed1", { [AGENT37_READY_METADATA.project]: OTHER, [AGENT37_READY_METADATA.state]: "claimed" }, "running"),
    ]);
    const removedRows: string[] = [];
    const keeper = createAgent37ReadyKeeper({
      client: async () => fake.client,
      settings: { read: async () => ({ projects: [keptReady], authoritative }), write: async () => undefined },
      createMachine: async () => {
        throw new Error("the pool is not empty; nothing should be made");
      },
      removeAccountMachine: async (machineKey) => {
        removedRows.push(machineKey);
      },
      preparerId: ME,
      templateAdeVersion: () => "1.2.129",
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
    const fake = fakeAgent37([
      { ...readyBox("nokey001"), metadata: { [AGENT37_READY_METADATA.project]: PROJECT, [AGENT37_READY_METADATA.state]: "ready" } },
      readyBox("good0001"),
    ]);

    const claim = await claimAgent37ReadyMachine(fake.client, PROJECT);

    expect(claim.instanceId).toBe("good0001");
    expect(claim.machineKey).toBe("key-good0001");
    expect(fake.boxes.get("good0001")?.status).toBe("running");
    // The machine with no ADE machine recorded is tagged failed (the keeper deletes it), not handed out.
    expect(fake.boxes.get("nokey001")?.metadata[AGENT37_READY_METADATA.state]).toBe("failed");

    expect(await releaseAgent37ReadyMachine(fake.client, "good0001", "another-callers-token")).toBe(false);
    expect(fake.boxes.get("good0001")?.metadata[AGENT37_READY_METADATA.state]).toBe("claimed");
    expect(fake.slept).toEqual([]);

    expect(await releaseAgent37ReadyMachine(fake.client, "good0001", claim.claimToken)).toBe(true);
    expect(fake.boxes.get("good0001")?.metadata[AGENT37_READY_METADATA.state]).toBe("ready");
    expect(fake.slept).toEqual(["good0001"]);
  });
});
