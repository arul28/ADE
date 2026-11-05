import { describe, expect, it } from "vitest";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { AGENT37_API_BASE_URL, AGENT37_SANDBOX_BASE_URL } from "../../../shared/agent37";
import { createAgent37Client } from "./agent37Client";
import { createAgent37Machine, type Agent37MachineCreatorDeps } from "./agent37MachineCreator";
import { createAgent37Machines } from "./agent37Machines";
import {
  createAgent37PendingCreateStore,
  readAgent37BoxSignedIn,
  reconcileAgent37PendingCreate,
} from "./agent37PendingCreates";

/**
 * Half-made Agent 37 boxes bill by the minute, and a box that signed in is
 * someone's real machine. These pin the two ways that goes wrong: a box left
 * billing, and a real machine deleted. Only Agent 37's HTTP API (fetch) and
 * the credential file are stand-ins.
 */

type FakeBox = {
  id: string;
  status: string;
  metadata: Record<string, string>;
  /** What `ade auth status --json` answers on the box; "unreachable" is Agent 37's transport error. */
  auth: { exitCode: number; stdout: string } | "unreachable";
  /** Agent 37 accepts the delete but the box never goes. */
  deleteNeverLands?: boolean;
};

function fakeAgent37(initial: FakeBox[], options: { createLosesAnswer?: (body: Record<string, unknown>) => FakeBox } = {}) {
  const boxes = new Map(initial.map((box) => [box.id, { ...box }]));
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const wire = (box: FakeBox) => ({ id: box.id, status: box.status, metadata: box.metadata });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const route = url.startsWith(AGENT37_SANDBOX_BASE_URL)
      ? `sandbox${url.slice(AGENT37_SANDBOX_BASE_URL.length)}`
      : url.slice(AGENT37_API_BASE_URL.length);
    calls.push(`${method} ${route}`);
    const exec = /^sandbox\/instances\/([^/]+)\/exec$/.exec(route);
    if (exec) {
      const box = boxes.get(decodeURIComponent(exec[1]!));
      if (!box || box.auth === "unreachable") return json(502, { error: "container_unreachable" });
      return json(200, { exit_code: box.auth.exitCode, stdout: box.auth.stdout, stderr: "" });
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
    if (route.startsWith("/templates/")) return json(200, { name: "ade", description: null });
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

function creatorDeps(fake: ReturnType<typeof fakeAgent37>, pendingCreates: Agent37MachineCreatorDeps["pendingCreates"]): Agent37MachineCreatorDeps {
  return {
    client: async () => createAgent37Client({ apiKey: "sk_test_fixture", fetch: fake.fetch }),
    getAccountToken: async () => "account-token",
    directoryBaseUrl: () => "https://directory.invalid",
    listAccountMachines: async () => { throw new Error("not reached in this fixture"); },
    renameMachine: async () => undefined,
    approveInWindow: async () => { throw new Error("not reached in this fixture"); },
    templateName: () => "ade",
    sleep: noWait,
    logger: quiet,
    pendingCreates,
  };
}

describe("Agent 37 half-made boxes", () => {
  it.each([
    { box: "answers signed out", auth: { exitCode: 0, stdout: "{\"signedIn\":false}" }, outcome: "deleted", boxRemains: false, recordRemains: false },
    { box: "has no ADE to ask (127)", auth: { exitCode: 127, stdout: "" }, outcome: "deleted", boxRemains: false, recordRemains: false },
    { box: "answers signed in", auth: { exitCode: 0, stdout: "{\"signedIn\":true}" }, outcome: "kept", boxRemains: true, recordRemains: false },
    { box: "is unreachable", auth: "unreachable" as const, outcome: "unresolved", boxRemains: true, recordRemains: true },
    { box: "times out answering", auth: { exitCode: 124, stdout: "" }, outcome: "unresolved", boxRemains: true, recordRemains: true },
    { box: "answers something unreadable", auth: { exitCode: 0, stdout: "starting…" }, outcome: "unresolved", boxRemains: true, recordRemains: true },
    { box: "answers signed out but its delete never lands", auth: { exitCode: 0, stdout: "{\"signedIn\":false}" }, deleteNeverLands: true, outcome: "unresolved", boxRemains: true, recordRemains: true },
  ])("the startup sweep finds a lost create by its request id; a box that $box is $outcome", async ({ auth, deleteNeverLands, outcome, boxRemains, recordRemains }) => {
    const fake = fakeAgent37([
      { id: "box-ours", status: "running", metadata: { created_by: "ade", ade_request_id: "req-1" }, auth, deleteNeverLands },
      // Someone else's box (another computer's create, or not ADE's at all).
      { id: "box-theirs", status: "running", metadata: { created_by: "ade", ade_request_id: "req-other" }, auth: { exitCode: 0, stdout: "{\"signedIn\":false}" } },
    ]);
    const file = memoryCredentialFile();
    const store = createAgent37PendingCreateStore(() => file.store, quiet);
    // Recorded before the create went out; the quit lost the box's id.
    store.begin("req-1", Date.now());
    const client = createAgent37Client({ apiKey: "sk_test_fixture", fetch: fake.fetch });

    const result = await reconcileAgent37PendingCreate(client, store.list()[0]!, {
      store,
      logger: quiet,
      sleep: noWait,
      isSignedIn: (instanceId) => readAgent37BoxSignedIn(client, instanceId, quiet),
    });

    expect(result[outcome as "deleted" | "kept" | "unresolved"]).toEqual(["box-ours"]);
    expect(fake.boxes.has("box-ours")).toBe(boxRemains);
    expect(store.list().map((record) => record.requestId)).toEqual(recordRemains ? ["req-1"] : []);
    expect(fake.boxes.has("box-theirs")).toBe(true);
    expect(fake.calls.filter((call) => call === "DELETE /instances/box-theirs")).toEqual([]);
  });

  it.each([
    { delete: "lands", deleteNeverLands: false, boxRemains: false, recordRemains: false, error: /Could not reach Agent 37/ },
    { delete: "never lands", deleteNeverLands: true, boxRemains: true, recordRemains: true, error: /tries again when ADE next starts/ },
  ])("a create whose answer was lost is found by its request id and deleted; its record goes only once the delete $delete", async ({ deleteNeverLands, boxRemains, recordRemains, error }) => {
    const fake = fakeAgent37([], {
      createLosesAnswer: (body) => ({
        id: "box-made",
        status: "running",
        metadata: body.metadata as Record<string, string>,
        auth: { exitCode: 0, stdout: "{\"signedIn\":false}" },
        deleteNeverLands,
      }),
    });
    const file = memoryCredentialFile();
    const store = createAgent37PendingCreateStore(() => file.store, quiet);

    await expect(createAgent37Machine(creatorDeps(fake, store), "req-lost", { kind: "box", shape: "2x4", name: "Lost answer" }, () => undefined))
      .rejects.toThrow(error);

    expect(fake.calls).toContain("DELETE /instances/box-made");
    expect(fake.boxes.has("box-made")).toBe(boxRemains);
    expect(store.list()).toEqual(recordRemains ? [expect.objectContaining({ requestId: "req-lost", instanceIds: ["box-made"] })] : []);
  });

  it.each<{ store: string; raw: Record<string, string>; failWrites: boolean }>([
    { store: "refuses the write", raw: {}, failWrites: true },
    { store: "holds records it can't read", raw: { "agent37.pendingCreates.v2": "[{\"requestId\":\"req-earlier\"," }, failWrites: false },
  ])("no box is made when the credential file $store, and what it held is not overwritten", async ({ raw, failWrites }) => {
    const fake = fakeAgent37([]);
    const file = memoryCredentialFile(raw, { failWrites });
    const store = createAgent37PendingCreateStore(() => file.store, quiet);

    await expect(createAgent37Machine(creatorDeps(fake, store), "req-new", { kind: "box", shape: "2x4", name: "Unrecorded" }, () => undefined))
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
    const fake = fakeAgent37(present
      ? [{ id: "box4ours", status: "running", metadata: { created_by: "ade", ade_machine_key: "key-1" }, auth: "unreachable", deleteNeverLands }]
      : []);
    const removed: string[] = [];
    const machines = createAgent37Machines({
      client: async () => createAgent37Client({ apiKey: "sk_test_fixture", fetch: fake.fetch }),
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
