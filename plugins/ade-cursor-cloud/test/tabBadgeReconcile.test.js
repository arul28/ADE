"use strict";

const assert = require("node:assert/strict");
const { describe, it, afterEach } = require("node:test");

const plugin = require("../index");
const tabBadge = require("../tabBadge");

/**
 * The unread badge across a plugin reload.
 *
 * The count lived in module memory while the published row lived in the host's
 * store, so a restarted child drew a badge that counted DOWN as more agents
 * finished: the row said 5, the counter said 0, and the next finish published
 * 1. The fix is a durable count, and the assertion that matters is the one
 * below — a second `activate` publishes what the first one left, not zero.
 */

/** The smallest host that lets `activate` and `deactivate` run to the end. */
function fakeSdk() {
  const rows = new Map();
  const published = [];
  return {
    published,
    rows,
    log() {},
    secrets: { getProviderKey: async () => null },
    events: { on: () => () => {} },
    chat: {},
    automations: {},
    webhooks: { status: async () => null, url: async () => null },
    actions: { invoke: async () => [] },
    panels: { update: async () => {} },
    contributions: {
      publish: async (entityKind, entityId, socket, payload) => {
        published.push({ entityKind, entityId, socket, payload });
      },
    },
    collections: {
      get: async (collection, key) => rows.get(`${collection}/${key}`) ?? null,
      put: async (collection, key, value) => {
        rows.set(`${collection}/${key}`, value);
      },
      list: async () => [],
      delete: async (collection, key) => {
        rows.delete(`${collection}/${key}`);
      },
    },
  };
}

function badgePublishes(sdk) {
  return sdk.published.filter((entry) => (
    entry.socket === "row-badge" && entry.entityId === tabBadge.TAB_ENTITY_ID
  ));
}

afterEach(async () => {
  await plugin.deactivate();
});

describe("unread tab badge across a reload", () => {
  it("publishes an empty badge on a first activate", async () => {
    const sdk = fakeSdk();
    await plugin.activate(sdk);
    const badges = badgePublishes(sdk);
    assert.ok(badges.length >= 1, "activate publishes the badge once");
    assert.equal(badges[0].payload, null);
  });

  it("republishes the stored count instead of restarting at zero", async () => {
    const first = fakeSdk();
    // What a run that saw five agents finish left behind.
    first.rows.set("deliveries/badge:unread-finished", { count: 5 });
    await plugin.activate(first);
    await plugin.deactivate();

    const badges = badgePublishes(first);
    assert.equal(badges[0].payload?.text, "5");

    // A second child, started against the same store, agrees with the row the
    // first one published rather than contradicting it.
    const second = fakeSdk();
    second.rows = first.rows;
    second.collections.get = async (collection, key) => first.rows.get(`${collection}/${key}`) ?? null;
    second.collections.put = async (collection, key, value) => {
      first.rows.set(`${collection}/${key}`, value);
    };
    await plugin.activate(second);
    assert.equal(badgePublishes(second)[0].payload?.text, "5");
  });

  it("stores the cleared count so the next child does not resurrect it", async () => {
    const sdk = fakeSdk();
    sdk.rows.set("deliveries/badge:unread-finished", { count: 3 });
    await plugin.activate(sdk);
    // The panel became visible: the host invokes the view action.
    await plugin.actions.ackTabBadge({ viewed: true });

    assert.deepEqual(sdk.rows.get("deliveries/badge:unread-finished"), { count: 0 });
    assert.equal(badgePublishes(sdk).at(-1).payload, null);
  });
});
