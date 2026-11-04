import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { MCP_SERVERS_SETTING_KEY, normalizeMcpRegistry } from "../../../shared/mcpRegistry";
import { MCP_SERVER_APPROVE_QUESTION_ID, MCP_SERVER_APPROVE_VALUE } from "../../../shared/mcpServerRequest";
import type { CardRequestChatInput } from "../chat/chatCardRequest";
import { createMcpRegistryService } from "./mcpRegistryService";
import {
  listMcpRegistry,
  mcpRegistryVaultFromStore,
  requestMcpServer,
  type McpRegistrySettingsStore,
  type McpRegistryVaultStore,
} from "./mcpServerRequest";

const LIST_KEY = `${ACCOUNT_SCOPE_ALL}\u0000${MCP_SERVERS_SETTING_KEY}`;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** The account's settings rows; `sync` stands in for the pull from the account. */
function accountSettings(sync: (rows: Map<string, unknown>) => Promise<"ready" | "unavailable" | "failed">) {
  const rows = new Map<string, unknown>();
  const store: McpRegistrySettingsStore = {
    get: (scope, key) => rows.get(`${scope}\u0000${key}`),
    set: (scope, key, value) => {
      rows.set(`${scope}\u0000${key}`, value);
      return true;
    },
    sync: () => sync(rows),
  };
  return { rows, store };
}

function accountVault(): McpRegistryVaultStore {
  const items = new Map<string, string>();
  const id = (scope: string, kind: string, key: string) => `${scope}\u0000${kind}\u0000${key}`;
  return {
    list: () => [...items.keys()].map((entry) => {
      const [scope, kind, key] = entry.split("\u0000") as [string, string, string];
      return { scope, kind, key, updatedAt: "2026-11-04T00:00:00.000Z", refreshOwner: null };
    }),
    get: (scope, kind, key) => items.get(id(scope, kind, key)) ?? null,
    set: (scope, kind, key, value) => {
      items.set(id(scope, kind, key), value);
      return true;
    },
    remove: (scope, kind, key) => items.delete(id(scope, kind, key)),
  };
}

function deps(settings: McpRegistrySettingsStore) {
  const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-request-"));
  homes.push(adeHome);
  const vault = accountVault();
  const noScan = () => ({ servers: [], skipped: [] });
  return {
    settings,
    vault,
    registry: createMcpRegistryService({
      vault: mcpRegistryVaultFromStore(() => vault),
      adeHome,
      scan: noScan,
      commandExists: () => true,
    }),
    scanConfigs: noScan,
    projectRoot: null,
  };
}

/** The person presses Add. A refused save keeps the card open until it times out, as the chat service does. */
function personApproves(refusals: unknown[]): CardRequestChatInput {
  return async (input) => {
    const answers = { [MCP_SERVER_APPROVE_QUESTION_ID]: [MCP_SERVER_APPROVE_VALUE] };
    try {
      await input.beforeAccept?.(answers);
    } catch (error) {
      refusals.push(error);
      return { decision: "none", answers: {}, responseText: null, timedOut: true };
    }
    return { decision: "accept", answers, responseText: null };
  };
}

const otherMachineServer = { name: "other", transport: "http", url: "https://other.example.com/mcp", envNames: [], headerNames: [], enabled: true };

describe("mcp_registry for agents", () => {
  it("never shows an agent a key the person wrote into a server's URL or command line", () => {
    const { rows, store } = accountSettings(async () => "ready");
    rows.set(LIST_KEY, [
      {
        name: "remote",
        transport: "http",
        url: "https://bob:hunter2@mcp.example.com/v1/sk-live1234567890abcd/tools?api_key=s3cr3tvalue&team=core#token=fragsecret",
        envNames: [],
        headerNames: [],
        enabled: true,
      },
      {
        name: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp", "--api-key", "plainkey123", "--token=tok456", "ghp_abcdefghijklmnop1234", "-e", "API_KEY=envkey789", "--header", "Authorization: Bearer hdrtoken99"],
        envNames: [],
        headerNames: [],
        enabled: true,
      },
    ]);

    const listing = JSON.stringify(listMcpRegistry(deps(store)));

    for (const secret of ["hunter2", "bob", "sk-live1234567890abcd", "s3cr3tvalue", "fragsecret", "plainkey123", "tok456", "ghp_abcdefghijklmnop1234", "envkey789", "hdrtoken99"]) {
      expect(listing, secret).not.toContain(secret);
    }
    // What the agent needs to recognise each server stays.
    expect(listing).toContain("mcp.example.com/v1/");
    expect(listing).toContain("some-mcp");
    expect(listing).toContain("--api-key");
  });

  it("keeps the servers another machine added when the card's save follows a stale local copy", async () => {
    // The local copy is empty; the account already holds a server from another machine.
    const { rows, store } = accountSettings(async (local) => {
      local.set(LIST_KEY, [otherMachineServer]);
      return "ready";
    });
    const refusals: unknown[] = [];

    const result = await requestMcpServer(
      { ...deps(store), requestChatInput: personApproves(refusals) },
      { chatSessionId: "chat-sync", name: "newsrv", reason: "To read the docs", url: "https://mcp.newsrv.dev/mcp" },
    );

    expect(refusals).toEqual([]);
    expect(result).toMatchObject({ name: "newsrv", added: true });
    expect(normalizeMcpRegistry(rows.get(LIST_KEY)).map((server) => server.name).sort()).toEqual(["newsrv", "other"]);
  });

  it.each(["failed", "unavailable"] as const)("writes no list when the pull %s and there is no copy of it", async (pulled) => {
    const { rows, store } = accountSettings(async () => pulled);
    const refusals: unknown[] = [];

    await expect(requestMcpServer(
      { ...deps(store), requestChatInput: personApproves(refusals) },
      { chatSessionId: `chat-${pulled}`, name: "newsrv", reason: "To read the docs", url: "https://mcp.newsrv.dev/mcp" },
    )).rejects.toThrow(/in time/);

    expect(refusals).toHaveLength(1);
    expect(String(refusals[0])).toMatch(/could not load your MCP servers/);
    expect(rows.has(LIST_KEY)).toBe(false);
  });
});
