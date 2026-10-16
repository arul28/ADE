import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAdeOpenCodeStoreDir } from "../../../shared/opencodeDataHome";

/**
 * The accounts service against a real OpenCode credential store (SQLite in a
 * temporary data home) and a stand-in for the OpenCode server process, which
 * changes that store the way OpenCode 2.0.29 does: a new login becomes the one
 * in use, `activate` switches, `remove` deletes.
 */

const server = vi.hoisted(() => ({
  failRemoves: 0,
  connects: [] as Array<{ integrationID: string; methodID: string }>,
  client: null as unknown,
}));

vi.mock("./openCodeServer", () => ({
  acquireOpenCodeServer: vi.fn(async () => ({ client: server.client, release: () => {} })),
  peekOpenCodeServerUrl: vi.fn(() => null),
}));

const { DatabaseSync } = createRequire(path.join(process.cwd(), "ade-runtime.cjs"))("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

let root = "";
let previousEnv: NodeJS.ProcessEnv;
let clock = 1_000;

function openStore(): DatabaseSyncType {
  const dir = resolveAdeOpenCodeStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS credential (
    id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, label TEXT, method_id TEXT,
    active INTEGER, time_updated INTEGER, value TEXT NOT NULL)`);
  return db;
}

function insertCredential(row: { id: string; integration: string; label: string; active: boolean; value: unknown }): void {
  const db = openStore();
  try {
    if (row.active) db.prepare("UPDATE credential SET active = 0 WHERE integration_id = ?").run(row.integration);
    db.prepare("INSERT INTO credential VALUES (?, ?, ?, '', ?, ?, ?)")
      .run(row.id, row.integration, row.label, row.active ? 1 : 0, clock++, JSON.stringify(row.value));
  } finally {
    db.close();
  }
}

/** What OpenCode does to its own store for each call ADE makes. */
function fakeOpenCodeClient() {
  return {
    integration: {
      list: async () => ({ data: [{
        id: "google-vertex",
        name: "Vertex",
        methods: [{ type: "key" }, { id: "google-adc", type: "external", label: "Google Cloud credentials" }],
      }] }),
      connect: {
        external: async (input: { integrationID: string; methodID: string; answer?: Record<string, string>; label?: string }) => {
          server.connects.push({ integrationID: input.integrationID, methodID: input.methodID });
          insertCredential({
            id: `cred-${clock}`,
            integration: input.integrationID,
            label: input.label ?? "Vertex",
            active: true,
            value: { type: "external", methodID: input.methodID, metadata: input.answer ?? {} },
          });
        },
      },
    },
    credential: {
      activate: async ({ credentialID }: { credentialID: string }) => {
        const db = openStore();
        try {
          const row = db.prepare("SELECT integration_id AS integration FROM credential WHERE id = ?").get(credentialID) as { integration: string };
          db.prepare("UPDATE credential SET active = (id = ?) WHERE integration_id = ?").run(credentialID, row.integration);
        } finally {
          db.close();
        }
      },
      remove: async ({ credentialID }: { credentialID: string }) => {
        if (server.failRemoves > 0) {
          server.failRemoves -= 1;
          throw new Error("database is locked");
        }
        const db = openStore();
        try {
          db.prepare("DELETE FROM credential WHERE id = ?").run(credentialID);
        } finally {
          db.close();
        }
      },
      update: async () => {},
    },
  };
}

/** The ADE account's settings as the brain holds them. */
function accountSettings(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    writable: true,
    isSignedIn: () => true,
    get: (scope: string, key: string) => values.get(`${scope}/${key}`),
    set(scope: string, key: string, value: unknown) {
      if (!this.writable) return false;
      values.set(`${scope}/${key}`, value);
      return true;
    },
  };
}

const vertexLogin = {
  providerId: "google-vertex",
  methodId: "google-adc",
  details: { project: "crumb-ios", location: "global" },
  label: "Crumb",
};

async function loadAccounts() {
  return await import("./openCodeAccounts");
}

function deps(settings: ReturnType<typeof accountSettings>) {
  return {
    projectRoot: root,
    projectConfig: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    accountSettings: settings,
  };
}

beforeEach(() => {
  previousEnv = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-accounts-"));
  process.env.ADE_HOME = path.join(root, "home");
  process.env.ADE_OPENCODE_XDG_ROOT = path.join(root, "xdg");
  server.failRemoves = 0;
  server.connects = [];
  server.client = fakeOpenCodeClient();
});

afterEach(() => {
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenCode accounts", () => {
  it("sets up the account's cloud logins on another computer without taking over the login in use", async () => {
    const { listOpenCodeAccounts } = await loadAccounts();
    insertCredential({ id: "work-key", integration: "google-vertex", label: "Work key", active: true, value: { type: "key", key: "secret" } });
    const settings = accountSettings({ "all/opencodeCloudLogins": [vertexLogin] });

    const { accounts } = await listOpenCodeAccounts(deps(settings), { providerId: "google-vertex" });

    expect(accounts.map((account) => [account.label, account.kind, account.active])).toEqual([
      ["Work key", "api_key", true],
      ["Crumb", "cloud", false],
    ]);
    expect(accounts[1]!.cloud).toMatchObject({ methodId: "google-adc", details: vertexLogin.details, synced: true });
    // Listing again finds nothing to do.
    await listOpenCodeAccounts(deps(settings), { providerId: "google-vertex" });
    expect(server.connects).toHaveLength(1);
    // No secret reaches the caller.
    expect(JSON.stringify(accounts)).not.toContain("secret");
  });

  it("removes a cloud login signed out on another computer, retrying a removal that failed", async () => {
    const { listOpenCodeAccounts } = await loadAccounts();
    const settings = accountSettings({ "all/opencodeCloudLogins": [vertexLogin] });
    await listOpenCodeAccounts(deps(settings), {});
    expect((await listOpenCodeAccounts(deps(settings), {})).accounts).toHaveLength(1);

    // Another computer signed it out of the account; OpenCode here is busy once.
    settings.values.set("all/opencodeCloudLogins", []);
    server.failRemoves = 1;
    expect((await listOpenCodeAccounts(deps(settings), {})).accounts).toHaveLength(1);
    expect((await listOpenCodeAccounts(deps(settings), {})).accounts).toEqual([]);
  });

  it("shows the newest login as in use when OpenCode has none marked", async () => {
    const { listOpenCodeAccounts } = await loadAccounts();
    insertCredential({ id: "older", integration: "openai", label: "Personal", active: false, value: { type: "oauth" } });
    insertCredential({ id: "newer", integration: "openai", label: "Work", active: false, value: { type: "oauth" } });
    insertCredential({ id: "other", integration: "anthropic", label: "Max", active: false, value: { type: "oauth" } });

    const { accounts } = await listOpenCodeAccounts(deps(accountSettings()), {});

    expect(accounts.filter((account) => account.active).map((account) => account.label).sort()).toEqual(["Max", "Work"]);
    expect(accounts.find((account) => account.label === "Personal")?.active).toBe(false);
    expect(accounts.every((account) => account.kind === "subscription")).toBe(true);
  });

  it("keeps a synced cloud login signed in when the ADE account cannot be updated", async () => {
    const { listOpenCodeAccounts, removeOpenCodeAccount } = await loadAccounts();
    const settings = accountSettings({ "all/opencodeCloudLogins": [vertexLogin] });
    const [login] = (await listOpenCodeAccounts(deps(settings), {})).accounts;
    expect(login?.cloud?.synced, "setup: synced login").toBe(true);

    settings.writable = false;
    const result = await removeOpenCodeAccount(deps(settings), { id: login!.id });

    expect(result.ok).toBe(false);
    expect(settings.values.get("all/opencodeCloudLogins")).toEqual([vertexLogin]);
    expect((await listOpenCodeAccounts(deps(settings), {})).accounts.map((account) => account.id)).toEqual([login!.id]);
  });
});
