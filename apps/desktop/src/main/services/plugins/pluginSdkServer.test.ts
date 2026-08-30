import { describe, expect, it } from "vitest";

import type { Logger } from "../logging/logger";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import {
  PluginSdkError,
  PLUGIN_WEBHOOK_SECRET_NAME,
  type PluginCollectionPutOptions,
} from "../../../shared/plugins/sdk";
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
  chatRuntimes: [],
  webhookIngress: [],
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
  configWrites: Record<string, unknown>[];
} {
  const puts: PutCall[] = [];
  const lists: ListCall[] = [];
  const configWrites: Record<string, unknown>[] = [];
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
    writeConfig: (values) => {
      configWrites.push(values);
      return { greeting: "Hei" };
    },
    ...overrides,
  });
  return { handle: server.handle, puts, lists, configWrites };
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
  type Posted = {
    pluginId: string;
    label: string;
    title: string;
    body?: string;
    target: string;
    deeplink?: string;
  };

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

  it("carries a link to one of its own panels, and costs only the link otherwise", async () => {
    const { handle, posted } = withNotifications();

    await handle("notifications.post", {
      input: { title: "Agent finished", deeplink: "ade://plugin/graph/detail" },
    });
    expect(posted[0]?.deeplink).toBe("ade://plugin/graph/detail");

    // A link somewhere else must not silence the news the user needed: the post
    // goes, and the tap falls back to opening the plugin that sent it.
    await handle("notifications.post", {
      input: { title: "Agent finished", deeplink: "ade://plugin/other/detail" },
    });
    expect(posted[1]?.title).toBe("Agent finished");
    expect(posted[1]?.deeplink).toBeUndefined();
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

/* ── Host-brokered provider keys ────────────────────────────────────────── */

describe("createPluginSdkServer secrets.getProviderKey", () => {
  /** A manifest that asked for the Cursor key and nothing else. */
  function declaringCursor(): PluginManifest {
    return { ...MANIFEST, providerKeys: ["cursor"] };
  }

  it("hands a declared provider's key to the plugin", async () => {
    const { handle } = createServer({
      manifest: declaringCursor(),
      readProviderKey: (provider) => (provider === "cursor" ? "key-abc" : null),
    });

    expect(await handle("secrets.getProviderKey", { provider: "cursor" })).toBe("key-abc");
  });

  it("refuses a provider the manifest never declared", async () => {
    const { handle } = createServer({
      manifest: declaringCursor(),
      readProviderKey: () => "key-abc",
    });

    // `not_permitted`, the same code an undeclared collection gets: the
    // manifest is the plugin's declared surface and the host does not widen it
    // at runtime.
    expect(await codeOf(() => handle("secrets.getProviderKey", { provider: "openai" })))
      .toBe("not_permitted");
  });

  it("refuses every provider for a manifest that declared none", async () => {
    const { handle } = createServer({ readProviderKey: () => "key-abc" });

    expect(await codeOf(() => handle("secrets.getProviderKey", { provider: "cursor" })))
      .toBe("not_permitted");
  });

  it("separates a typo from a missing declaration", async () => {
    const { handle } = createServer({ manifest: declaringCursor() });

    expect(await codeOf(() => handle("secrets.getProviderKey", { provider: "cursour" })))
      .toBe("invalid_args");
  });

  it("answers null when the provider is declared and no key is connected", async () => {
    const { handle } = createServer({
      manifest: declaringCursor(),
      readProviderKey: () => null,
    });

    // Not an error: "connect a key in Settings" is a sentence the plugin should
    // draw, not a failure it should report.
    expect(await handle("secrets.getProviderKey", { provider: "cursor" })).toBeNull();
  });

  it("answers null on a host with no key store at all", async () => {
    const { handle } = createServer({ manifest: declaringCursor() });

    expect(await handle("secrets.getProviderKey", { provider: "cursor" })).toBeNull();
  });

  it("never reaches the plugin's own secret store", async () => {
    const touched: string[] = [];
    const { handle } = createServer({
      manifest: declaringCursor(),
      readProviderKey: () => "key-abc",
      secrets: {
        get: async (_id: string, name: string) => {
          touched.push(name);
          return null;
        },
        set: async (_id: string, name: string) => {
          touched.push(name);
        },
        delete: async () => {},
        removeAll: async () => {},
      } as PluginSecretStore,
    });

    await handle("secrets.getProviderKey", { provider: "cursor" });

    // The whole point of the broker: one key, one store. A copy written here
    // would drift the moment the user rotated the key in Settings.
    expect(touched).toEqual([]);
  });

  it("takes the provider case-insensitively, like the key store does", async () => {
    const seen: string[] = [];
    const { handle } = createServer({
      manifest: declaringCursor(),
      readProviderKey: (provider) => {
        seen.push(provider);
        return "key-abc";
      },
    });

    expect(await handle("secrets.getProviderKey", { provider: "Cursor" })).toBe("key-abc");
    expect(seen).toEqual(["cursor"]);
  });
});

describe("createPluginSdkServer secrets.hasProviderKey", () => {
  it("says whether a key is there without reading it", async () => {
    const manifest: PluginManifest = { ...MANIFEST, providerKeys: ["cursor"] };
    const present = createServer({ manifest, readProviderKey: () => "key-abc" });
    const absent = createServer({ manifest, readProviderKey: () => null });

    expect(await present.handle("secrets.hasProviderKey", { provider: "cursor" })).toBe(true);
    expect(await absent.handle("secrets.hasProviderKey", { provider: "cursor" })).toBe(false);
  });

  it("obeys the same declaration rule as the read", async () => {
    const { handle } = createServer({ readProviderKey: () => "key-abc" });

    expect(await codeOf(() => handle("secrets.hasProviderKey", { provider: "cursor" })))
      .toBe("not_permitted");
  });
});

describe("createPluginSdkServer webhooks", () => {
  function declaringIngress(): PluginManifest {
    return {
      ...MANIFEST,
      webhookIngress: [
        { id: "default", label: "Default" },
        { id: "billing", label: "Billing" },
      ],
    };
  }

  it("answers the drain's URL for a declared channel, defaulting the channel id", async () => {
    const asked: { pluginId: string; channelId: string }[] = [];
    const { handle } = createServer({
      manifest: declaringIngress(),
      webhooks: {
        url: (pluginId, channelId) => {
          asked.push({ pluginId, channelId });
          return `https://relay.example/plugin/${pluginId}/webhook`;
        },
        ack: () => {},
      },
    });

    expect(await handle("webhooks.url", {})).toBe("https://relay.example/plugin/graph/webhook");
    expect(await handle("webhooks.url", { channelId: "billing" })).toBe(
      "https://relay.example/plugin/graph/webhook",
    );
    expect(asked).toEqual([
      { pluginId: "graph", channelId: "default" },
      { pluginId: "graph", channelId: "billing" },
    ]);
  });

  // A URL for a channel the manifest never declared is a URL the relay accepts
  // posts on and the drain then throws away — worse than no URL at all.
  it("refuses a channel the manifest does not declare", async () => {
    const { handle } = createServer({
      manifest: declaringIngress(),
      webhooks: { url: () => "https://relay.example/plugin/graph/webhook", ack: () => {} },
    });

    expect(await codeOf(() => handle("webhooks.url", { channelId: "payroll" }))).toBe("invalid_args");
  });

  it("refuses rather than guessing when the drain cannot resolve a declared channel", async () => {
    const { handle } = createServer({
      manifest: declaringIngress(),
      webhooks: { url: () => null, ack: () => {} },
    });

    expect(await codeOf(() => handle("webhooks.url", {}))).toBe("unsupported_method");
  });

  it("says so plainly on a host with no drain", async () => {
    const { handle } = createServer({ manifest: declaringIngress() });

    expect(await codeOf(() => handle("webhooks.url", {}))).toBe("unsupported_method");
    expect(await codeOf(() => handle("webhooks.ack", { deliveryId: "d-1" }))).toBe("unsupported_method");
  });

  it("acks by delivery id, scoped to the calling plugin", async () => {
    const acked: { pluginId: string; deliveryId: string }[] = [];
    const { handle } = createServer({
      manifest: declaringIngress(),
      webhooks: {
        url: () => "https://relay.example/plugin/graph/webhook",
        ack: (pluginId, deliveryId) => {
          acked.push({ pluginId, deliveryId });
        },
      },
    });

    expect(await handle("webhooks.ack", { deliveryId: "d-1" })).toBeNull();
    expect(acked).toEqual([{ pluginId: "graph", deliveryId: "d-1" }]);
    expect(await codeOf(() => handle("webhooks.ack", {}))).toBe("invalid_args");
  });

  // A plugin that could read the relay secret could hand its own ingress to
  // anyone; one that could write it would deauthorize itself silently.
  it("keeps the relay registration secret out of every secret verb", async () => {
    const { handle } = createServer({ manifest: declaringIngress() });

    expect(await codeOf(() => handle("secrets.get", { name: PLUGIN_WEBHOOK_SECRET_NAME })))
      .toBe("not_permitted");
    expect(await codeOf(() => handle("secrets.set", { name: PLUGIN_WEBHOOK_SECRET_NAME, value: "x" })))
      .toBe("not_permitted");
    expect(await codeOf(() => handle("secrets.delete", { name: PLUGIN_WEBHOOK_SECRET_NAME })))
      .toBe("not_permitted");
  });
});

describe("createPluginSdkServer chat", () => {
  const CHAT_MANIFEST: PluginManifest = {
    ...MANIFEST,
    chatRuntimes: [{
      id: "cloud",
      displayName: "Cursor Cloud",
      capabilities: { followUp: true, interrupt: true, hydrate: true, artifacts: true },
    }],
  };

  function chatServer(overrides: Record<string, unknown> = {}) {
    const calls: { verb: string; args: unknown[] }[] = [];
    const record = (verb: string) => async (...args: unknown[]) => {
      calls.push({ verb, args });
      if (verb === "createSession") {
        return { sessionId: "session-1", runtimeId: "cloud", externalId: "bc-1", created: true };
      }
      // `hydrate` answers with what the page did, so a plugin can stop paging
      // once ADE says it already had that far back.
      if (verb === "hydrate") return { accepted: 1, skipped: 0, sweepTotal: 1 };
      return undefined;
    };
    const { handle } = createServer({
      manifest: CHAT_MANIFEST,
      chat: {
        createSession: record("createSession"),
        appendAssistant: record("appendAssistant"),
        appendUser: record("appendUser"),
        emitStatus: record("emitStatus"),
        setArtifacts: record("setArtifacts"),
        attachBranch: record("attachBranch"),
        hydrate: record("hydrate"),
      },
      ...overrides,
    } as never);
    return { handle, calls };
  }

  it("binds a session to a runtime the manifest declares", async () => {
    const { handle, calls } = chatServer();
    const result = await handle("chat.createSession", {
      input: { runtimeId: "cloud", externalId: "bc-1", laneId: "lane-1" },
    });
    expect(result).toMatchObject({ sessionId: "session-1", created: true });
    // The plugin id is the one the server was BUILT for; the plugin never
    // states its own.
    expect(calls[0]?.args[0]).toBe("graph");
  });

  it("refuses a runtime the manifest never declared", async () => {
    const { handle, calls } = chatServer();
    // `invalid_args`, not `not_permitted`: nothing was withheld, the id is wrong.
    expect(await codeOf(() => handle("chat.createSession", {
      input: { runtimeId: "ghost", externalId: "bc-1", laneId: "lane-1" },
    }))).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("refuses every runtime for a manifest that declared none", async () => {
    const { handle } = chatServer({ manifest: MANIFEST });
    expect(await codeOf(() => handle("chat.createSession", {
      input: { runtimeId: "cloud", externalId: "bc-1", laneId: "lane-1" },
    }))).toBe("invalid_args");
  });

  it("says so plainly on a host that runs no chat service", async () => {
    const { handle } = createServer({ manifest: CHAT_MANIFEST });
    expect(await codeOf(() => handle("chat.appendAssistant", {
      sessionId: "session-1",
      chunk: { text: "hi" },
    }))).toBe("unsupported_method");
  });

  it("passes the calling plugin's id to every write verb", async () => {
    const { handle, calls } = chatServer();
    await handle("chat.appendAssistant", { sessionId: "session-1", chunk: { text: "hi" } });
    await handle("chat.appendUser", { sessionId: "session-1", input: { text: "hello" } });
    await handle("chat.emitStatus", { sessionId: "session-1", status: { state: "idle" } });
    await handle("chat.hydrate", { sessionId: "session-1", transcript: [{ role: "user", text: "a" }] });
    expect(calls.map((call) => call.verb)).toEqual([
      "appendAssistant",
      "appendUser",
      "emitStatus",
      "hydrate",
    ]);
    // Ownership is decided against this value, and it is never one the plugin
    // supplied.
    expect(calls.every((call) => call.args[0] === "graph")).toBe(true);
  });

  it("refuses a write with no session id rather than guessing one", async () => {
    const { handle, calls } = chatServer();
    expect(await codeOf(() => handle("chat.appendAssistant", { chunk: { text: "hi" } })))
      .toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});

describe("createPluginSdkServer chat.hydrate paging", () => {
  const CHAT_MANIFEST: PluginManifest = {
    ...MANIFEST,
    chatRuntimes: [{
      id: "cloud",
      displayName: "Cursor Cloud",
      capabilities: { followUp: true, interrupt: true, hydrate: true, artifacts: true },
    }],
  };

  function hydrateServer() {
    const calls: { transcriptLength: number; options: unknown }[] = [];
    const { handle } = createServer({
      manifest: CHAT_MANIFEST,
      chat: {
        createSession: async () => ({ sessionId: "s", runtimeId: "cloud", externalId: "e", created: true }),
        appendAssistant: async () => undefined,
        appendUser: async () => undefined,
        emitStatus: async () => undefined,
        setArtifacts: async () => undefined,
        attachBranch: async () => undefined,
        hydrate: async (
          _pluginId: string,
          _sessionId: string,
          transcript: unknown[],
          options: unknown,
        ) => {
          calls.push({ transcriptLength: transcript.length, options });
          return { accepted: transcript.length, skipped: 0, sweepTotal: transcript.length };
        },
      },
    } as never);
    return { handle, calls };
  }

  it("passes the continuation flag through and hands back the page result", async () => {
    const { handle, calls } = hydrateServer();
    const result = await handle("chat.hydrate", {
      sessionId: "session-1",
      transcript: [{ role: "user", text: "One" }],
      options: { append: true },
    });
    expect(result).toEqual({ accepted: 1, skipped: 0, sweepTotal: 1 });
    expect(calls[0]?.options).toEqual({ append: true });
  });

  it("reads a first page as a fresh sweep", async () => {
    const { handle, calls } = hydrateServer();
    await handle("chat.hydrate", {
      sessionId: "session-1",
      transcript: [{ role: "user", text: "One" }],
    });
    // Absent options stay absent rather than becoming `{append: false}`, so the
    // writer sees the same thing an older plugin sends.
    expect(calls[0]?.options).toBeUndefined();
  });

  it("reads a malformed options bag tolerantly", async () => {
    const { handle, calls } = hydrateServer();
    // Getting `append` wrong costs a plugin nothing — the fingerprint dedupe
    // still stops a page landing twice — so this normalizes rather than throws.
    for (const options of [{ append: "yes" }, { append: 1 }, {}]) {
      await handle("chat.hydrate", {
        sessionId: "session-1",
        transcript: [{ role: "user", text: "One" }],
        options,
      });
    }
    expect(calls.map((call) => call.options)).toEqual([
      { append: false },
      { append: false },
      { append: false },
    ]);
  });

  it("still refuses a page past the per-call cap", async () => {
    const { handle } = hydrateServer();
    const transcript = Array.from({ length: 501 }, () => ({ role: "user", text: "x" }));
    expect(await codeOf(() => handle("chat.hydrate", { sessionId: "session-1", transcript })))
      .toBe("plugin_budget_exceeded");
  });
});

/**
 * `config.set` at the wire.
 *
 * The manifest validation itself lives in the host (`applyStoredConfig`, shared
 * with ADE's own settings form) and is proved end to end in
 * `pluginHostService.test.ts`. What is this layer's own contract is narrower:
 * the frame it forwards, and that it answers with the host's new config rather
 * than inventing one.
 */
describe("createPluginSdkServer config.set", () => {
  it("forwards the values frame to the host and answers with the config it returns", async () => {
    const { handle, configWrites } = createServer();

    const answer = await handle("config.set", { values: { greeting: "Hei", loud: true } });

    expect(configWrites).toEqual([{ greeting: "Hei", loud: true }]);
    expect(answer).toEqual({ greeting: "Hei" });
  });

  it("carries a null through rather than dropping it, because null is the reset", async () => {
    const { handle, configWrites } = createServer();

    await handle("config.set", { values: { greeting: null } });

    // A frame that stripped nulls would turn "put this setting back to its
    // default" into a no-op the plugin could not tell from a success.
    expect(configWrites).toEqual([{ greeting: null }]);
  });

  it("refuses a values frame that is not an object", async () => {
    expect(await codeOf(() => createServer().handle("config.set", { values: "greeting=Hei" })))
      .toBe("invalid_args");
  });

  it("treats an absent values frame as a write of nothing", async () => {
    const { handle, configWrites } = createServer();

    await handle("config.set", {});

    expect(configWrites).toEqual([{}]);
  });
});
