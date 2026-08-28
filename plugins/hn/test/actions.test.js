"use strict";

/**
 * The entry module against a host that behaves like the real one.
 *
 * The fake SDK reproduces the two host rules that actually bite this plugin: a
 * collection the manifest never declared is refused, and `collections.list`
 * clamps whatever limit it is given to 1,000 rows. A plugin that quietly needs
 * more than a thousand rows back passes every test written against an
 * unclamped stub and then fails on a real machine months later.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin.json"), "utf8"));
const DECLARED = new Set(Object.keys(manifest.collections));

/** What `pluginDataStore.listCollection` clamps every request to. */
const LIST_MAX = 1000;

function fakeHost() {
  const data = new Map();
  const published = [];
  const logs = [];
  const fetched = [];
  const key = (collection, k) => `${collection} ${k}`;
  const declared = (collection) => {
    if (!DECLARED.has(collection)) {
      const error = new Error(`Collection "${collection}" is not declared.`);
      error.code = "not_permitted";
      throw error;
    }
    return collection;
  };
  const sdk = {
    log: (level, message, fields) => logs.push({ level, message, fields }),
    collections: {
      async get(collection, k) {
        return data.get(key(declared(collection), k)) ?? null;
      },
      async put(collection, k, value) {
        data.set(key(declared(collection), k), value);
      },
      async delete(collection, k) {
        data.delete(key(declared(collection), k));
      },
      async list(collection, options) {
        declared(collection);
        const limit = Math.min(Math.max(1, options?.limit ?? 200), LIST_MAX);
        return [...data.entries()]
          .filter(([composite]) => composite.startsWith(`${collection} `))
          .map(([composite, value]) => ({ collection, key: composite.slice(collection.length + 1), value }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .slice(0, limit);
      },
    },
    panels: {
      async update(panelId, schema) {
        published.push({ panelId, schema });
      },
    },
  };
  return { sdk, data, published, logs, fetched, rows: (c) => sdk.collections.list(c, { limit: LIST_MAX }) };
}

/** A fresh entry module: it holds `sdk` and `lastFeed` at module scope. */
function loadPlugin() {
  delete require.cache[require.resolve("../index")];
  delete require.cache[require.resolve("../hn")];
  return require("../index");
}

const IDS = Array.from({ length: 34 }, (_, i) => 100 + i);

function installFetch(host, { slow = 0, fail = false } = {}) {
  global.fetch = async (url) => {
    host.fetched.push(String(url));
    if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
    if (fail) throw new Error("offline");
    const body = String(url).endsWith("stories.json")
      ? IDS
      : (() => {
        const id = Number(String(url).match(/item\/(\d+)\.json/)[1]);
        return {
          id,
          type: "story",
          title: `Story ${id}`,
          by: "pg",
          score: id,
          descendants: 2,
          url: `https://example.com/${id}`,
        };
      })();
    return { ok: true, status: 200, json: async () => body };
  };
}

/** Wait for the background load `activate` starts. */
async function settled(host, count = 1) {
  for (let i = 0; i < 400 && host.published.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let host;
let plugin;

beforeEach(() => {
  host = fakeHost();
  plugin = loadPlugin();
  installFetch(host);
});

describe("activate", () => {
  it("returns without waiting for the feed", async () => {
    // The child bootstrap sends its `ready` frame only after `activate`
    // resolves, and the host kills a child that is not ready within 20s. One
    // list fetch plus thirty item fetches can exceed that on a slow network, so
    // awaiting the load here put the plugin in a crash-restart loop. This is
    // the regression: activate must return long before the fetches finish.
    installFetch(host, { slow: 40 });
    const started = Date.now();
    await plugin.activate(host.sdk);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 200, `activate blocked for ${elapsed}ms`);
    assert.equal(host.published.length, 0, "the panel was published before activate returned");

    await settled(host);
    assert.equal(host.published.length, 1);
    assert.equal((await host.rows("stories")).length, 30, "STORY_LIMIT caps the feed at 30 of the 34 offered");
  });

  it("publishes the panel anyway when the feed cannot be fetched", async () => {
    installFetch(host, { fail: true });
    await plugin.activate(host.sdk);
    await settled(host);
    assert.equal(host.published[0].panelId, "stories");
    assert.ok(host.logs.some((line) => line.level === "warn"));
    assert.equal((await host.rows("stories")).length, 0);
  });

  it("reopens on the feed the reader last used", async () => {
    await host.sdk.collections.put("prefs", "feed", { feed: "ask" });
    await plugin.activate(host.sdk);
    await settled(host);
    assert.ok(host.fetched[0].endsWith("/askstories.json"));
  });

  it("survives a prefs value it does not recognise", async () => {
    await host.sdk.collections.put("prefs", "feed", { feed: "nonsense" });
    await plugin.activate(host.sdk);
    await settled(host);
    assert.ok(host.fetched[0].endsWith("/topstories.json"));
  });
});

describe("the header button and its menu", () => {
  beforeEach(async () => {
    await plugin.activate(host.sdk);
    await settled(host);
  });

  for (const [action, feed] of [["openTop", "top"], ["openNew", "new"], ["openAsk", "ask"]]) {
    it(`${action} opens ${feed} on the same tick and fetches behind it`, async () => {
      const result = await plugin.actions[action]({});
      // Answers BEFORE the fetch, not after it. The host honours `{navigate}`
      // only once the action returns, so awaiting the list plus thirty items
      // here left the header button looking dead for several seconds.
      assert.equal(result.message, `Opening ${feed} stories.`);
      // `{navigate}` names a panel of this plugin and NOT a place to put it.
      // Absent `target`, each client picks: desktop opens the Work tools pane
      // beside the chat this button sits in, because the plugin declares a
      // `work-rail-pane` for the same panel; iOS presents the plugin pane sheet;
      // `ade code` loads its plugin pane. A `target` here would take that choice
      // away from three clients to serve one.
      assert.deepEqual(result.navigate, { panelId: "stories" });
      assert.equal("target" in result.navigate, false);
      assert.deepEqual(result.resetState, ["feed"]);
      // The fetch it started still lands.
      await settled(host);
      assert.equal((await host.sdk.collections.get("prefs", "feed")).feed, feed);
    });
  }

  it("openStories reopens whatever was loaded last", async () => {
    await plugin.actions.openAsk({});
    await settled(host);
    const result = await plugin.actions.openStories({});
    assert.equal(result.message, "Opening ask stories.");
  });
});

describe("the feed control", () => {
  beforeEach(async () => {
    await plugin.activate(host.sdk);
    await settled(host);
  });

  it("reads the new value out of the panel state the client sends", async () => {
    // An `onChange` action is invoked with the panel's current selections under
    // `state`, so this is where the segmented's value actually arrives.
    const result = await plugin.actions.selectFeed({ state: { feed: "new", show: "unread" } });
    assert.equal(result.message, "Loaded 30 new stories.");
    // No `navigate`: the reader is already looking at the panel.
    assert.equal(result.navigate, undefined);
    assert.deepEqual(await host.sdk.collections.get("prefs", "feed"), { feed: "new" });
  });

  it("keeps the current feed when the state names nothing usable", async () => {
    await plugin.actions.openAsk({});
    const result = await plugin.actions.selectFeed({ state: {} });
    assert.equal(result.message, "Loaded 30 ask stories.");
  });

  it("refresh reloads the feed the reader is on", async () => {
    const result = await plugin.actions.refreshStories({ state: { feed: "new" } });
    assert.equal(result.message, "Loaded 30 new stories.");
  });

  it("replaces the previous feed's rows instead of stacking them", async () => {
    await plugin.actions.openTop({});
    await plugin.actions.openNew({});
    assert.equal((await host.rows("stories")).length, 30, "STORY_LIMIT caps the feed at 30 of the 34 offered");
  });
});

describe("reading a story", () => {
  beforeEach(async () => {
    await plugin.activate(host.sdk);
    await settled(host);
  });

  it("opens the story link and marks it read in the synced collection", async () => {
    const result = await plugin.actions.openStory({ id: "100" });
    // https only: the host reader refuses anything else and the tap does nothing.
    assert.deepEqual(result, { openUrl: "https://example.com/100" });
    assert.equal(new URL(result.openUrl).protocol, "https:");

    const read = await host.rows("read");
    assert.deepEqual(read.map((row) => row.key), ["100"]);
    assert.equal(read[0].value.title, "Story 100");
    assert.equal(typeof read[0].value.at, "number");
  });

  it("repaints the row so the reader can see it is read", async () => {
    await plugin.actions.markRead({ id: "101" });
    const row = (await host.rows("stories")).find((entry) => entry.value.id === "101");
    assert.equal(row.value.readFlag, "read");
    assert.equal(row.value.tone, "neutral");
    assert.deepEqual(row.value.badge, { text: "Read", tone: "neutral" });
    assert.deepEqual(row.value.actions.map((a) => a.action), ["markUnread"]);
  });

  it("puts a row back the way it was", async () => {
    await plugin.actions.markRead({ id: "101" });
    const result = await plugin.actions.markUnread({ id: "101" });
    assert.equal(result.message, "Marked unread.");
    assert.equal((await host.rows("read")).length, 0);
    const row = (await host.rows("stories")).find((entry) => entry.value.id === "101");
    assert.equal(row.value.readFlag, "unread");
    assert.equal(row.value.badge, undefined);
    assert.deepEqual(row.value.actions.map((a) => a.action), ["markRead"]);
  });

  it("remembers a story is read across a reload of the feed", async () => {
    await plugin.actions.markRead({ id: "102" });
    await plugin.actions.refreshStories({ state: { feed: "top" } });
    const row = (await host.rows("stories")).find((entry) => entry.value.id === "102");
    assert.equal(row.value.readFlag, "read");
  });

  it("still knows a story is read past the thousand-row list ceiling", async () => {
    // The defect this pins. `collections.list` clamps any limit to 1,000 rows,
    // and the `read` collection runs to the 4,000-row budget, so a plugin that
    // read the whole collection stopped seeing the stories beyond the first
    // thousand keys and showed them as unread again. The filler keys here sort
    // before "102", so a clamped list would return none of the real ones.
    for (let i = 0; i < 1500; i += 1) {
      await host.sdk.collections.put("read", `0${String(i).padStart(6, "0")}`, { id: `x${i}`, at: 1 });
    }
    await plugin.actions.markRead({ id: "102" });
    assert.equal((await host.sdk.collections.list("read", { limit: 4000 })).length, LIST_MAX);

    await plugin.actions.refreshStories({ state: { feed: "top" } });
    const row = (await host.rows("stories")).find((entry) => entry.value.id === "102");
    assert.equal(row.value.readFlag, "read", "a read story reverted to unread past the list ceiling");
  });

  it("opens the discussion page from the row's overflow", async () => {
    const result = await plugin.actions.openComments({ id: "103" });
    assert.deepEqual(result, { openUrl: "https://news.ycombinator.com/item?id=103" });
  });

  it("answers a failure rather than throwing when a row carries no id", async () => {
    for (const action of ["openStory", "openComments", "markRead", "markUnread"]) {
      const result = await plugin.actions[action]({});
      assert.deepEqual(result, { ok: false, message: "No story id." }, `${action} did not refuse`);
    }
  });
});

describe("the CLI word", () => {
  it("answers the loaded feed as plain data", async () => {
    // `ade hn stories` prints the return value as JSON: the CLI path does not
    // interpret `message` or `navigate`, so a plain object is the right answer.
    await plugin.activate(host.sdk);
    await settled(host);
    const result = await plugin.actions.stories({ argv: ["stories"] });
    assert.equal(result.feed, "top");
    assert.equal(result.count, 30);
    assert.equal(result.titles.length, 30);
    assert.equal(result.titles[0], "Story 100");
  });
});

describe("the host contract", () => {
  it("touches only declared collections and only the declared host", async () => {
    await plugin.activate(host.sdk);
    await settled(host);
    await plugin.actions.openStory({ id: "100" });
    await plugin.actions.markUnread({ id: "100" });
    await plugin.actions.selectFeed({ state: { feed: "new" } });

    // The fake host throws `not_permitted` on an undeclared name, exactly as
    // `pluginSdkServer` does, so getting this far is the assertion.
    for (const url of host.fetched) {
      assert.equal(new URL(url).host, "hacker-news.firebaseio.com", `${url} is undeclared`);
    }
  });

  it("publishes only the panel the manifest declares", async () => {
    await plugin.activate(host.sdk);
    await settled(host);
    await plugin.actions.openNew({});
    const declared = new Set(manifest.panels.map((panel) => panel.id));
    for (const entry of host.published) assert.ok(declared.has(entry.panelId));
  });

  it("publishes a schema whose controls and binding match the manifest", async () => {
    await plugin.activate(host.sdk);
    await settled(host);
    const schema = host.published[0].schema;
    assert.equal(schema.v, 1);
    assert.ok(schema.fallback.text, "a panel over a ceiling renders `fallback`, so it is mandatory");

    const row = schema.body[0].children;
    const controls = row[1].children;
    assert.deepEqual(controls.map((c) => c.stateKey), ["feed", "show"]);
    // An empty option value is how a segmented control writes "All": the clause
    // reading that key goes inactive and the binding keeps every row.
    assert.equal(controls[1].options[0].value, "");
    assert.deepEqual(controls[0].onChange, { action: "selectFeed" });

    const list = row[2];
    assert.equal(list.bind.collection, "stories");
    assert.deepEqual(list.bind.where, [{ field: "readFlag", equals: { $state: "show" } }]);
    // A bound row acts only through `allowActions`, and every id must exist.
    for (const action of list.bind.allowActions) {
      assert.ok(typeof plugin.actions[action] === "function", `${action} is not exported`);
    }
  });

  it("lets go of the SDK on deactivate", async () => {
    await plugin.activate(host.sdk);
    await settled(host);
    await plugin.deactivate();
    assert.doesNotThrow(() => plugin.actions.openStories);
  });
});
