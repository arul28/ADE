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
  official: false,
};

type PutCall = {
  collection: string;
  key: string;
  value: unknown;
  options: PluginCollectionPutOptions | undefined;
};

function createServer(): {
  handle: ReturnType<typeof createPluginSdkServer>["handle"];
  puts: PutCall[];
} {
  const puts: PutCall[] = [];
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
  } as unknown as PluginDataStore;
  const server = createPluginSdkServer({
    pluginId: "graph",
    manifest: MANIFEST,
    logger: silentLogger(),
    data,
    secrets: {} as PluginSecretStore,
    invokeAdeAction: async () => null,
    readConfig: () => ({}),
  });
  return { handle: server.handle, puts };
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
