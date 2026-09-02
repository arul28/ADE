"use strict";

function collectionStore() {
  const bags = new Map();
  function bag(name) {
    if (!bags.has(name)) bags.set(name, new Map());
    return bags.get(name);
  }
  return {
    async put(collection, key, value) {
      bag(collection).set(key, { key, value });
    },
    async get(collection, key) {
      return bag(collection).get(key)?.value ?? null;
    },
    async list(collection, opts = {}) {
      const prefix = typeof opts.keyPrefix === "string" ? opts.keyPrefix : "";
      const limit = Number(opts.limit) || 400;
      const rows = [];
      for (const [key, row] of bag(collection)) {
        if (prefix && !key.startsWith(prefix)) continue;
        rows.push(row);
        if (rows.length >= limit) break;
      }
      return rows;
    },
    async delete(collection, key) {
      bag(collection).delete(key);
    },
    bags,
  };
}

function createSdk(overrides = {}) {
  const panels = new Map();
  const collections = collectionStore();
  const lanesApi = {
    list: async () => [],
    get: async () => null,
    ...(overrides.lanes ?? {}),
  };
  return {
    log() {},
    ...overrides,
    panels: {
      async update(id, schema) {
        panels.set(id, schema);
      },
    },
    collections,
    lanes: lanesApi,
    events: overrides.events ?? {
      on() {
        return () => {};
      },
    },
    panelsMap: panels,
  };
}

function sampleLane(overrides = {}) {
  return {
    id: "lane-1",
    name: "fix-login",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "fix-login",
    parentLaneId: null,
    status: "idle",
    ...overrides,
  };
}

module.exports = { createSdk, sampleLane };
