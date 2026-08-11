import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createPluginDataStore } from "./pluginDataStore";
import { createPluginInstallService } from "./pluginInstallService";
import {
  emitPluginChange,
  PLUGIN_CHANGED_EVENT_TYPE,
  resetPluginChangeListenersForTests,
  subscribeToPluginChanges,
  type PluginChangeEvent,
} from "./pluginEvents";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/hello-plugin",
);

const openDatabases: AdeDb[] = [];
const tempRoots: string[] = [];

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

function scratchRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-events-"));
  tempRoots.push(root);
  return root;
}

function record(): PluginChangeEvent[] {
  const events: PluginChangeEvent[] = [];
  subscribeToPluginChanges((event) => events.push(event));
  return events;
}

afterEach(() => {
  resetPluginChangeListenersForTests();
  while (openDatabases.length) openDatabases.pop()?.close();
  while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("plugin change bus", () => {
  it("delivers to every subscriber and stops after unsubscribe", () => {
    const first: PluginChangeEvent[] = [];
    const second: PluginChangeEvent[] = [];
    const detach = subscribeToPluginChanges((event) => first.push(event));
    subscribeToPluginChanges((event) => second.push(event));

    emitPluginChange({ kind: "installs", pluginId: "hello-plugin" });
    detach();
    emitPluginChange({ kind: "status", pluginId: "hello-plugin", status: "running" });

    expect(first).toEqual([{ kind: "installs", pluginId: "hello-plugin" }]);
    expect(second).toHaveLength(2);
  });

  // A producer is usually mid-write when it emits. A subscriber that throws
  // must not roll back the write that already succeeded, nor rob the other
  // subscribers of the notification.
  it("isolates a throwing subscriber from the emitter and its peers", () => {
    const survived: PluginChangeEvent[] = [];
    subscribeToPluginChanges(() => {
      throw new Error("subscriber exploded");
    });
    subscribeToPluginChanges((event) => survived.push(event));

    expect(() => emitPluginChange({ kind: "panels", pluginId: "hello-plugin", panelId: "main" })).not.toThrow();
    expect(survived).toHaveLength(1);
  });

  // The republished shape is the contract every client filters on; spelling it
  // out here is what stops a rename in the bus from silently going unnoticed.
  it("republishes as a runtime event whose payload keeps the change fields", () => {
    const pushed: { category: string; payload: Record<string, unknown> }[] = [];
    subscribeToPluginChanges((event) => {
      pushed.push({ category: "runtime", payload: { type: PLUGIN_CHANGED_EVENT_TYPE, ...event } });
    });

    emitPluginChange({ kind: "collections", pluginId: "hello-plugin", collection: "greetings" });

    expect(pushed).toEqual([{
      category: "runtime",
      payload: {
        type: "plugin_changed",
        kind: "collections",
        pluginId: "hello-plugin",
        collection: "greetings",
      },
    }]);
  });
});

describe("install lifecycle emissions", () => {
  it("reports install, enable, disable and uninstall", async () => {
    const events = record();
    const install = createPluginInstallService({
      logger: silentLogger(),
      pluginsRoot: path.join(scratchRoot(), "plugins"),
    });

    await install.install({ source: fixtureRoot });
    install.setEnabled("hello-plugin", false);
    install.setEnabled("hello-plugin", true);
    install.uninstall("hello-plugin");

    expect(events).toEqual([
      { kind: "installs", pluginId: "hello-plugin" },
      { kind: "installs", pluginId: "hello-plugin" },
      { kind: "installs", pluginId: "hello-plugin" },
      { kind: "installs", pluginId: "hello-plugin" },
    ]);
  });

  it("stays quiet when uninstall removed nothing", () => {
    const events = record();
    const install = createPluginInstallService({
      logger: silentLogger(),
      pluginsRoot: path.join(scratchRoot(), "plugins"),
    });

    expect(install.uninstall("never-installed")).toEqual({ removed: false });
    expect(events).toEqual([]);
  });
});

describe("data write emissions", () => {
  async function openStore() {
    const db = await openKvDb(path.join(scratchRoot(), ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    return createPluginDataStore({ db });
  }

  it("names the collection that moved, and still calls the sync hook", async () => {
    const db = await openKvDb(path.join(scratchRoot(), ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    const onCollectionChanged = vi.fn();
    const store = createPluginDataStore({ db, onCollectionChanged });
    const events = record();

    store.putCollection("hello-plugin", "greetings", "boot", { greeting: "hi" });
    store.deleteCollection("hello-plugin", "greetings", "boot");

    expect(events).toEqual([
      { kind: "collections", pluginId: "hello-plugin", collection: "greetings" },
      { kind: "collections", pluginId: "hello-plugin", collection: "greetings" },
    ]);
    expect(onCollectionChanged).toHaveBeenCalledTimes(2);
  });

  it("reports a panel rewrite with its panel id", async () => {
    const store = await openStore();
    const events = record();

    store.updatePanel("hello-plugin", "main", {
      schema: { v: 1, fallback: { title: "Hello", text: "…" }, body: [] },
      vocabVersion: 1,
    });

    expect(events).toEqual([{ kind: "panels", pluginId: "hello-plugin", panelId: "main" }]);
  });

  it("reports a contribution publish", async () => {
    const store = await openStore();
    const events = record();

    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "hi", tone: "accent" });

    expect(events).toEqual([{ kind: "contributions", pluginId: "hello-plugin" }]);
  });

  // Budget refusals happen inside the writer transaction, so nothing landed and
  // a subscriber told otherwise would refetch and cache the pre-write state.
  it("says nothing when the write was refused", async () => {
    const store = await openStore();
    const events = record();

    expect(() => store.putCollection("hello-plugin", "greetings", "big", { blob: "x".repeat(70_000) })).toThrow();
    expect(events).toEqual([]);
  });
});
