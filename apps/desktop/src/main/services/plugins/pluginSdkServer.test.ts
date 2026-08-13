import { describe, expect, it } from "vitest";

import type { Logger } from "../logging/logger";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import { PluginSdkError, type PluginCollectionPutOptions } from "../../../shared/plugins/sdk";
import type { PluginDataStore } from "./pluginDataStore";
import type { PluginSecretStore } from "./pluginSecretStore";
import { createPluginSdkServer } from "./pluginSdkServer";

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

const MANIFEST: PluginManifest = {
  name: "graph",
  version: "1.0.0",
  displayName: "Graph",
  description: "",
  vocabVersion: 1,
  surfaces: [],
  panels: [],
  sockets: [],
  collections: { cache: { sync: false } },
  settings: [],
  cli: [],
  skills: [],
  tools: [],
  automationTriggers: [],
  automationSteps: [],
  searchProviders: [],
  keybindings: [],
  official: false,
};

type PutCall = {
  collection: string;
  key: string;
  value: unknown;
  options: PluginCollectionPutOptions | undefined;
};

type ListCall = { collection: string; options: { keyPrefix?: string; limit?: number } | undefined };

function createServer(
  overrides?: Partial<Parameters<typeof createPluginSdkServer>[0]>,
): {
  handle: ReturnType<typeof createPluginSdkServer>["handle"];
  puts: PutCall[];
  lists: ListCall[];
} {
  const puts: PutCall[] = [];
  const lists: ListCall[] = [];
  const data = {
    putCollection(
      _pluginId: string,
      collection: string,
      key: string,
      value: unknown,
      options?: PluginCollectionPutOptions,
    ) {
      puts.push({ collection, key, value, options });
    },
    getCollection(_pluginId: string, collection: string, key: string) {
      return { collection, key };
    },
    deleteCollection() {},
    listCollection(
      _pluginId: string,
      collection: string,
      options?: { keyPrefix?: string; limit?: number },
    ) {
      lists.push({ collection, options });
      return [];
    },
  } as unknown as PluginDataStore;
  const server = createPluginSdkServer({
    pluginId: "graph",
    manifest: MANIFEST,
    logger: silentLogger(),
    data,
    secrets: {} as PluginSecretStore,
    invokeAdeAction: async () => null,
    readConfig: () => ({}),
    ...overrides,
  });
  return { handle: server.handle, puts, lists };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PluginSdkError) return error.code;
    throw error;
  }
  throw new Error("Expected the SDK server to refuse this call.");
}

describe("createPluginSdkServer collections.put", () => {
  it("passes no options through when the plugin sent none", async () => {
    const { handle, puts } = createServer();

    await handle("collections.put", { collection: "cache", key: "a", value: 1 });

    // Not `{}` and not `{ ifFull: undefined }`: a plugin that predates the
    // option reaches the store as a caller that never mentioned it.
    expect(puts[0]?.options).toBeUndefined();
  });

  it("carries a valid ifFull through to the store", async () => {
    const { handle, puts } = createServer();

    await handle("collections.put", {
      collection: "cache",
      key: "a",
      value: 1,
      options: { ifFull: "evictOldest" },
    });

    expect(puts[0]?.options).toEqual({ ifFull: "evictOldest" });
  });

  it("refuses an ifFull it does not know rather than reading it as the default", async () => {
    const { handle, puts } = createServer();

    // The silent-default reading is the dangerous one: a plugin with a typo
    // would behave correctly until the day its collection filled.
    expect(await codeOf(() => handle("collections.put", {
      collection: "cache",
      key: "a",
      value: 1,
      options: { ifFull: "evictoldest" },
    }))).toBe("invalid_args");
    expect(await codeOf(() => handle("collections.put", {
      collection: "cache",
      key: "a",
      value: 1,
      options: { ifFull: true },
    }))).toBe("invalid_args");
    expect(await codeOf(() => handle("collections.put", {
      collection: "cache",
      key: "a",
      value: 1,
      options: "evictOldest",
    }))).toBe("invalid_args");
    expect(puts).toHaveLength(0);
  });

  it("treats an options frame without ifFull as the default", async () => {
    const { handle, puts } = createServer();

    await handle("collections.put", { collection: "cache", key: "a", value: 1, options: {} });

    expect(puts[0]?.options).toBeUndefined();
  });

  it("still refuses a collection the manifest never declared", async () => {
    const { handle } = createServer();

    expect(await codeOf(() => handle("collections.put", {
      collection: "undeclared",
      key: "a",
      value: 1,
      options: { ifFull: "evictOldest" },
    }))).toBe("not_permitted");
  });
});

describe("createPluginSdkServer notifications.post", () => {
  type Posted = { pluginId: string; label: string; title: string; body?: string; target: string };

  function withNotifications(): { handle: ReturnType<typeof createServer>["handle"]; posted: Posted[] } {
    const posted: Posted[] = [];
    const { handle } = createServer({
      postNotification: async (input) => {
        posted.push(input);
        return { delivered: ["desktop"] };
      },
    });
    return { handle, posted };
  }

  it("stamps the manifest's display name and never a name the plugin passes", async () => {
    const { handle, posted } = withNotifications();

    // `label` is exactly the attribution a malicious plugin would want to set.
    await handle("notifications.post", { input: { title: "Build failed", label: "ADE", pluginId: "ade" } });

    expect(posted[0]?.label).toBe("Graph");
    expect(posted[0]?.pluginId).toBe("graph");
  });

  it("defaults to both targets and refuses a target it does not know", async () => {
    const { handle, posted } = withNotifications();

    await handle("notifications.post", { input: { title: "Done" } });
    expect(posted[0]?.target).toBe("both");

    // Rounding an unknown target down to the default would let a typo look
    // like it worked while notifying somewhere the author never chose.
    expect(await codeOf(() => handle("notifications.post", {
      input: { title: "Done", target: "Mobile" },
    }))).toBe("invalid_args");
    expect(posted).toHaveLength(1);
  });

  it("refuses a title or body past the render ceiling instead of truncating", async () => {
    const { handle, posted } = withNotifications();

    expect(await codeOf(() => handle("notifications.post", { input: { title: "x".repeat(81) } })))
      .toBe("invalid_args");
    expect(await codeOf(() => handle("notifications.post", {
      input: { title: "ok", body: "y".repeat(241) },
    }))).toBe("invalid_args");
    expect(await codeOf(() => handle("notifications.post", { input: { title: "" } })))
      .toBe("invalid_args");
    expect(posted).toHaveLength(0);
  });

  it("refuses cleanly on a host wired without anywhere to show one", async () => {
    const { handle } = createServer();

    expect(await codeOf(() => handle("notifications.post", { input: { title: "Done" } })))
      .toBe("notification_unavailable");
  });
});

describe("createPluginSdkServer memory", () => {
  it("scopes every verb to the reserved collection the plugin cannot name", async () => {
    const { handle, puts, lists } = createServer();

    await handle("memory.set", { key: "last-run", value: 1 });
    await handle("memory.list", { options: { keyPrefix: "last" } });

    expect(puts[0]?.collection).toBe("ade.memory");
    // No `ifFull`: memory that evicted silently would be the one store in ADE
    // that forgets without saying so.
    expect(puts[0]?.options).toBeUndefined();
    expect(lists[0]?.collection).toBe("ade.memory");
  });

  it("refuses the reserved name through collections, even if a manifest declared it", async () => {
    const declared = createServer({
      manifest: { ...MANIFEST, collections: { "ade.memory": { sync: false } } },
    });

    // Declaring it must not open a second door onto the same rows.
    expect(await codeOf(() => declared.handle("collections.put", {
      collection: "ade.memory",
      key: "a",
      value: 1,
    }))).toBe("not_permitted");
    expect(await codeOf(() => declared.handle("collections.get", {
      collection: "ade.memory",
      key: "a",
    }))).toBe("not_permitted");
    expect(declared.puts).toHaveLength(0);
  });
});

describe("createPluginSdkServer host capabilities", () => {
  it("refuses the Electron-only verbs with desktop_unavailable when none is attached", async () => {
    const { handle } = createServer();

    // `desktop_unavailable` and not `unsupported_method`: the verb exists, the
    // desktop does not, and a plugin should retry when one appears.
    expect(await codeOf(() => handle("clipboard.read", {}))).toBe("desktop_unavailable");
    expect(await codeOf(() => handle("clipboard.write", { text: "x" }))).toBe("desktop_unavailable");
    expect(await codeOf(() => handle("dialogs.pickFile", {}))).toBe("desktop_unavailable");
  });

  it("propagates a typed bridge refusal rather than flattening it", async () => {
    const { handle } = createServer({
      desktopHost: {
        readClipboard: async () => "",
        writeClipboard: async () => {},
        pickFile: async () => {
          throw new PluginSdkError("dialog_cancelled", "The picker was dismissed.");
        },
      },
    });

    expect(await codeOf(() => handle("dialogs.pickFile", {}))).toBe("dialog_cancelled");
  });

  it("refuses clipboard text past the ceiling before crossing the bridge", async () => {
    let wrote = 0;
    const { handle } = createServer({
      desktopHost: {
        readClipboard: async () => "",
        writeClipboard: async () => {
          wrote += 1;
        },
        pickFile: async () => "/tmp/x",
      },
    });

    expect(await codeOf(() => handle("clipboard.write", { text: "x".repeat(64 * 1024 + 1) })))
      .toBe("plugin_budget_exceeded");
    expect(wrote).toBe(0);
  });

  it("refuses schedules with unsupported_method on a host that runs no scheduler", async () => {
    const { handle } = createServer();

    // Unlike a missing desktop, a missing scheduler cannot appear later, so
    // "try again" would be wrong advice.
    expect(await codeOf(() => handle("schedules.list", {}))).toBe("unsupported_method");
    expect(await codeOf(() => handle("schedules.create", { input: { action: "run" } })))
      .toBe("unsupported_method");
  });

  it("scopes schedule calls to the calling plugin's own id", async () => {
    const seen: string[] = [];
    const { handle } = createServer({
      schedules: {
        create: (pluginId) => {
          seen.push(pluginId);
          return {} as never;
        },
        list: (pluginId) => {
          seen.push(pluginId);
          return [];
        },
        delete: (pluginId) => {
          seen.push(pluginId);
        },
      },
    });

    await handle("schedules.create", { input: { action: "run", delaySeconds: 60, pluginId: "other" } });
    await handle("schedules.list", { pluginId: "other" });
    await handle("schedules.delete", { scheduleId: "s1", pluginId: "other" });

    // The id comes from the server's construction, never from the wire.
    expect(seen).toEqual(["graph", "graph", "graph"]);
  });
});

describe("createPluginSdkServer automations.emitTrigger", () => {
  const declaring = (): PluginManifest => ({
    ...MANIFEST,
    automationTriggers: [{ id: "issueMoved", label: "Issue moved" }],
  });

  it("hands a declared trigger to the engine, attributed by the host", async () => {
    const emitted: unknown[] = [];
    const { handle } = createServer({
      manifest: declaring(),
      emitAutomationTrigger: async (args) => {
        emitted.push(args);
      },
    });

    await handle("automations.emitTrigger", {
      input: { triggerId: "issueMoved", payload: { issueId: "ADE-7" }, pluginId: "other" },
    });

    // The plugin id comes from the server's construction, never from the wire.
    expect(emitted).toEqual([
      { pluginId: "graph", triggerId: "issueMoved", payload: { issueId: "ADE-7" } },
    ]);
  });

  it("omits an absent payload rather than sending an empty bag", async () => {
    const emitted: unknown[] = [];
    const { handle } = createServer({
      manifest: declaring(),
      emitAutomationTrigger: async (args) => {
        emitted.push(args);
      },
    });

    await handle("automations.emitTrigger", { input: { triggerId: "issueMoved" } });

    expect(emitted).toEqual([{ pluginId: "graph", triggerId: "issueMoved" }]);
  });

  it("refuses a trigger the manifest never declared", async () => {
    let calls = 0;
    const { handle } = createServer({
      manifest: declaring(),
      emitAutomationTrigger: async () => {
        calls += 1;
      },
    });

    // The rule builder draws its picker from the manifest, so an undeclared
    // trigger is one no rule could exist for: firing it would be a permanent
    // silent no-op rather than a mistake anyone could see.
    expect(await codeOf(() => handle("automations.emitTrigger", { input: { triggerId: "nope" } })))
      .toBe("invalid_args");
    expect(calls).toBe(0);
  });

  it("refuses with unsupported_method on a host that runs no automation engine", async () => {
    const { handle } = createServer({ manifest: declaring() });

    expect(await codeOf(() => handle("automations.emitTrigger", { input: { triggerId: "issueMoved" } })))
      .toBe("unsupported_method");
  });

  it("refuses a payload over the byte ceiling before the engine sees it", async () => {
    let calls = 0;
    const { handle } = createServer({
      manifest: declaring(),
      emitAutomationTrigger: async () => {
        calls += 1;
      },
    });

    expect(await codeOf(() => handle("automations.emitTrigger", {
      input: { triggerId: "issueMoved", payload: { blob: "x".repeat(4 * 1024 + 1) } },
    }))).toBe("plugin_budget_exceeded");
    expect(calls).toBe(0);
  });
});
