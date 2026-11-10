import { describe, expect, it } from "vitest";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { createCloudServerProvider } from "./cloudServerProvider";

const createProvider = ({ fetch }: { fetch: (url: string, init?: RequestInit) => Promise<Response> }) =>
  createCloudServerProvider({ accessToken: async () => "account-token", baseUrl: () => "https://directory.invalid", fetch });
import { createCloudMachine, type CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { createCloudMachines } from "./cloudMachines";
import {
  createCloudPendingCreateStore,
  readCloudBoxSignedIn,
  reconcileCloudPendingCreate,
} from "./cloudPendingCreates";

/**
 * Half-made cloud boxes bill by the minute, and a box that signed in is
 * someone's real machine. These pin the two ways that goes wrong: a box left
 * billing, and a real machine deleted. Only the provider's HTTP API (fetch) and
 * the credential file are stand-ins.
 */

type FakeBox = {
  id: string;
  status: string;
  metadata: Record<string, string>;
  /** What `ade auth status --json` answers on the box; "unreachable" is the provider's transport error. */
  auth: { exitCode: number; stdout: string } | "unreachable";
  /** the provider accepts the delete but the box never goes. */
  deleteNeverLands?: boolean;
};

function fakeCloud(initial: FakeBox[], options: { createLosesAnswer?: (body: Record<string, unknown>) => FakeBox } = {}) {
  const boxes = new Map(initial.map((box) => [box.id, { ...box }]));
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const wire = (box: FakeBox) => ({ id: box.id, status: box.status, metadata: box.metadata });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const route = url.slice("https://directory.invalid/cloud".length);
    calls.push(`${method} ${route}`);
    const exec = /^\/instances\/([^/]+)\/exec$/.exec(route);
    if (exec) {
      const box = boxes.get(decodeURIComponent(exec[1]!));
      if (!box || box.auth === "unreachable") return json(502, { error: { code: "container_unreachable", message: "unreachable" } });
      return json(200, { exitCode: box.auth.exitCode, stdout: box.auth.stdout, stderr: "" });
    }
    if (route === "/instances" && method === "GET") return json(200, { data: [...boxes.values()].map(wire) });
    if (route === "/instances" && method === "POST") {
      const made = options.createLosesAnswer?.(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (made) {
        boxes.set(made.id, made);
        throw new TypeError("fetch failed");
      }
      return json(500, { error: { code: "internal_error", message: "not in this fixture" } });
    }
    if (route.startsWith("/templates/")) return json(200, { exists: true });
    const one = /^\/instances\/([^/]+)$/.exec(route);
    if (one) {
      const box = boxes.get(decodeURIComponent(one[1]!));
      if (!box) return json(404, { error: { code: "not_found", message: "gone" } });
      if (method === "DELETE") {
        if (!box.deleteNeverLands) boxes.delete(box.id);
        return new Response(null, { status: 204 });
      }
      return json(200, wire(box));
    }
    return json(500, { error: { code: "internal_error", message: `no route ${method} ${route}` } });
  };
  return { fetch, calls, boxes };
}

/** The shared credential file, in memory. `failWrites` / a raw value it can't parse stand for a broken disk. */
function memoryCredentialFile(raw: Record<string, string> = {}, options: { failWrites?: boolean } = {}) {
  const values = new Map(Object.entries(raw));
  const store = {
    getSync: (key: string) => values.get(key) ?? null,
    setSync: (key: string, value: string) => {
      if (options.failWrites) throw new Error("EACCES: permission denied");
      values.set(key, value);
    },
    deleteSync: (key: string) => {
      if (options.failWrites) throw new Error("EACCES: permission denied");
      values.delete(key);
    },
  } as unknown as SyncCredentialStore;
  return { store, values };
}

const quiet = { info: () => undefined, warn: () => undefined };
const noWait = async () => undefined;

function creatorDeps(fake: ReturnType<typeof fakeCloud>, pendingCreates: CloudMachineCreatorDeps["pendingCreates"]): CloudMachineCreatorDeps {
  return {
    client: async () => createProvider({ fetch: fake.fetch }),
    getAccountToken: async () => "account-token",
    directoryBaseUrl: () => "https://directory.invalid",
    listAccountMachines: async () => { throw new Error("not reached in this fixture"); },
    renameMachine: async () => undefined,
    approveInWindow: async () => { throw new Error("not reached in this fixture"); },
    sleep: noWait,
    logger: quiet,
    pendingCreates,
  };
}

describe("ADE Cloud half-made boxes", () => {
  it.each([
    { box: "answers signed out", auth: { exitCode: 0, stdout: "{\"signedIn\":false}" }, outcome: "deleted", boxRemains: false, recordRemains: false },
    { box: "has no ADE to ask (127)", auth: { exitCode: 127, stdout: "" }, outcome: "deleted", boxRemains: false, recordRemains: false },
    { box: "answers signed in", auth: { exitCode: 0, stdout: "{\"signedIn\":true}" }, outcome: "kept", boxRemains: true, recordRemains: false },
    { box: "is unreachable", auth: "unreachable" as const, outcome: "unresolved", boxRemains: true, recordRemains: true },
    { box: "times out answering", auth: { exitCode: 124, stdout: "" }, outcome: "unresolved", boxRemains: true, recordRemains: true },
    { box: "answers something unreadable", auth: { exitCode: 0, stdout: "starting…" }, outcome: "unresolved", boxRemains: true, recordRemains: true },
    { box: "answers signed out but its delete never lands", auth: { exitCode: 0, stdout: "{\"signedIn\":false}" }, deleteNeverLands: true, outcome: "unresolved", boxRemains: true, recordRemains: true },
  ])("the startup sweep finds a lost create by its request id; a box that $box is $outcome", async ({ auth, deleteNeverLands, outcome, boxRemains, recordRemains }) => {
    const fake = fakeCloud([
      { id: "box-ours", status: "running", metadata: { created_by: "ade", ade_request_id: "req-1" }, auth, deleteNeverLands },
      // Someone else's box (another computer's create, or not ADE's at all).
      { id: "box-theirs", status: "running", metadata: { created_by: "ade", ade_request_id: "req-other" }, auth: { exitCode: 0, stdout: "{\"signedIn\":false}" } },
    ]);
    const file = memoryCredentialFile();
    const store = createCloudPendingCreateStore(() => file.store, quiet);
    // Recorded before the create went out; the quit lost the box's id.
    store.begin("req-1", Date.now());
    const client = createProvider({ fetch: fake.fetch });

    const result = await reconcileCloudPendingCreate(client, store.list()[0]!, {
      store,
      logger: quiet,
      sleep: noWait,
      isSignedIn: (instanceId) => readCloudBoxSignedIn(client, instanceId, quiet),
    });

    expect(result[outcome as "deleted" | "kept" | "unresolved"]).toEqual(["box-ours"]);
    expect(fake.boxes.has("box-ours")).toBe(boxRemains);
    expect(store.list().map((record) => record.requestId)).toEqual(recordRemains ? ["req-1"] : []);
    expect(fake.boxes.has("box-theirs")).toBe(true);
    expect(fake.calls.filter((call) => call === "DELETE /instances/box-theirs")).toEqual([]);
  });

  it.each([
    { delete: "lands", deleteNeverLands: false, boxRemains: false, recordRemains: false, error: /Could not reach ADE Cloud/ },
    { delete: "never lands", deleteNeverLands: true, boxRemains: true, recordRemains: true, error: /tries again when ADE next starts/ },
  ])("a create whose answer was lost is found by its request id and deleted; its record goes only once the delete $delete", async ({ deleteNeverLands, boxRemains, recordRemains, error }) => {
    const fake = fakeCloud([], {
      createLosesAnswer: (body) => ({
        id: "box-made",
        status: "running",
        metadata: body.metadata as Record<string, string>,
        auth: { exitCode: 0, stdout: "{\"signedIn\":false}" },
        deleteNeverLands,
      }),
    });
    const file = memoryCredentialFile();
    const store = createCloudPendingCreateStore(() => file.store, quiet);

    await expect(createCloudMachine(creatorDeps(fake, store), "req-lost", { kind: "box", shape: "2x4", name: "Lost answer" }, () => undefined))
      .rejects.toThrow(error);

    expect(fake.calls).toContain("DELETE /instances/box-made");
    expect(fake.boxes.has("box-made")).toBe(boxRemains);
    expect(store.list()).toEqual(recordRemains ? [expect.objectContaining({ requestId: "req-lost", instanceIds: ["box-made"] })] : []);
  });

  it.each<{ store: string; raw: Record<string, string>; failWrites: boolean }>([
    { store: "refuses the write", raw: {}, failWrites: true },
    { store: "holds records it can't read", raw: { "cloud.pendingCreates.v2": "[{\"requestId\":\"req-earlier\"," }, failWrites: false },
  ])("no box is made when the credential file $store, and what it held is not overwritten", async ({ raw, failWrites }) => {
    const fake = fakeCloud([]);
    const file = memoryCredentialFile(raw, { failWrites });
    const store = createCloudPendingCreateStore(() => file.store, quiet);

    await expect(createCloudMachine(creatorDeps(fake, store), "req-new", { kind: "box", shape: "2x4", name: "Unrecorded" }, () => undefined))
      .rejects.toThrow(/didn't make one/);

    expect(fake.calls.filter((call) => call === "POST /instances")).toEqual([]);
    expect(Object.fromEntries(file.values)).toEqual(raw);
    expect(() => store.begin("req-new", Date.now())).toThrow();
  });

  it.each([
    { box: "goes", present: true, rowRemoval: "works" as const, ok: true, boxRemains: false, rowsRemoved: ["key-1"], rowLeft: undefined },
    { box: "was already gone", present: false, rowRemoval: "works" as const, ok: true, boxRemains: false, rowsRemoved: ["key-1"], rowLeft: undefined },
    { box: "goes but its account row can't be removed", present: true, rowRemoval: "throws" as const, ok: true, boxRemains: false, rowsRemoved: [], rowLeft: true },
    { box: "never goes", present: true, deleteNeverLands: true, rowRemoval: "works" as const, ok: false, boxRemains: true, rowsRemoved: [], rowLeft: undefined },
  ])("Delete box removes the account row only once the box is gone: a box that $box", async ({ present, deleteNeverLands, rowRemoval, ok, boxRemains, rowsRemoved, rowLeft }) => {
    const fake = fakeCloud(present
      ? [{ id: "box4ours", status: "running", metadata: { created_by: "ade", ade_machine_key: "key-1" }, auth: "unreachable", deleteNeverLands }]
      : []);
    const removed: string[] = [];
    const machines = createCloudMachines({
      client: async () => createProvider({ fetch: fake.fetch }),
      removeAccountMachine: async (machineKey) => {
        if (rowRemoval === "throws") throw new Error("The account directory refused the removal.");
        removed.push(machineKey);
      },
      logger: quiet,
      sleep: noWait,
    });

    const result = await machines.run({ instanceId: "box4ours", action: "delete", machineKey: "key-1" });

    expect(result.ok).toBe(ok);
    expect(result.accountRowLeft).toBe(rowLeft);
    expect(fake.boxes.has("box4ours")).toBe(boxRemains);
    // A box that still bills keeps its row, so it never drops out of sight.
    expect(removed).toEqual(rowsRemoved);
  });
});

describe("which machines are cloud computers", () => {
  it("answers without the machine list read, and does not keep asking for a laptop or a failing server", async () => {
    let nowMs = 1_000_000;
    let reads = 0;
    let serverDown = false;
    let hasAccess = false;
    const keys = ["cloud-key"];
    const provider = {
      listInstances: async () => {
        reads += 1;
        if (serverDown) throw new Error("ADE Cloud is down.");
        return keys.map((key, index) => ({ id: `box${index}`, status: "running", metadata: { created_by: "ade", ade_machine_key: key } }));
      },
    } as never;
    const machines = createCloudMachines({
      client: async () => provider,
      knownClient: () => (hasAccess ? provider : null),
      removeAccountMachine: async () => {},
      logger: quiet,
      sleep: noWait,
      now: () => nowMs,
    });

    // No ADE Cloud access: nothing is asked, so a laptop's connect never waits.
    expect(await machines.knowsBox("cloud-key")).toBe(false);
    expect(reads).toBe(0);

    // Nobody opened the machine list. Two callers at once share one read.
    hasAccess = true;
    expect(await Promise.all([machines.knowsBox("cloud-key"), machines.knowsBox("cloud-key")])).toEqual([true, true]);
    expect(reads).toBe(1);
    expect(await machines.knowsBox("cloud-key")).toBe(true);
    expect(reads).toBe(1);

    // A laptop is asked about once, then not again until that answer is old.
    expect(await machines.knowsBox("laptop-key")).toBe(false);
    expect(reads).toBe(2);
    expect(await machines.knowsBox("laptop-key")).toBe(false);
    expect(reads).toBe(2);
    nowMs += 11 * 60_000;
    expect(await machines.knowsBox("laptop-key")).toBe(false);
    expect(reads).toBe(3);

    // A computer made since is found at once; a failing server is left alone for a minute.
    keys.push("new-key");
    serverDown = true;
    expect(await machines.knowsBox("new-key")).toBe(false);
    expect(await machines.knowsBox("new-key")).toBe(false);
    expect(reads).toBe(4);
    serverDown = false;
    nowMs += 61_000;
    expect(await machines.knowsBox("new-key")).toBe(true);
    expect(reads).toBe(5);
  });
});
