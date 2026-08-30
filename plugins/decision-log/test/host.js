"use strict";

/**
 * A host stub that behaves the way the real host behaves at its ceilings.
 *
 * A stub with no limits proves nothing about the machine the plugin will
 * actually run on, so this one clamps `list`, refuses a `put` past its row cap
 * with the real error code, and implements `ifFull: "evictOldest"` by dropping
 * the oldest keys IN THAT COLLECTION — never reaching into another.
 */

/** The real `collections.list` clamp and default. */
const LIST_CLAMP = 1000;
const LIST_DEFAULT = 200;

function budgetError() {
  const error = new Error("plugin_budget_exceeded");
  error.code = "plugin_budget_exceeded";
  error.detail = { budget: "rows", limit: 0, actual: 0 };
  return error;
}

function makeHost(options = {}) {
  const maxRows = options.maxRows ?? 4000;
  const lanes = options.lanes ?? [
    { id: "lane-a", name: "Search rewrite" },
    { id: "lane-b", name: "Billing" },
  ];
  const sessions = options.sessions ?? { "sess-1": { sessionId: "sess-1", laneId: "lane-a" } };

  /** collection -> Map(key -> value) */
  const store = new Map();
  const calls = {
    published: [],
    panels: [],
    invokes: [],
    notifications: [],
    logs: [],
    schedulesCreated: [],
    schedulesDeleted: [],
  };
  let schedules = [];
  let scheduleSeq = 0;
  let config = Object.assign({ digestEnabled: false, digestDay: "1" }, options.config);

  const bucket = (collection) => {
    if (!store.has(collection)) store.set(collection, new Map());
    return store.get(collection);
  };
  const totalRows = () => [...store.values()].reduce((sum, map) => sum + map.size, 0);

  const host = {
    pluginId: "decision-log",
    sdkVersion: 0,

    collections: {
      async get(collection, key) {
        const value = bucket(collection).get(key);
        return value === undefined ? null : value;
      },
      async put(collection, key, value, opts) {
        const map = bucket(collection);
        const isNew = !map.has(key);
        if (isNew && totalRows() >= maxRows) {
          if (opts && opts.ifFull === "evictOldest") {
            // Oldest by key order, and only within this collection.
            const oldest = [...map.keys()].sort().pop();
            if (oldest === undefined) throw budgetError();
            map.delete(oldest);
          } else {
            throw budgetError();
          }
        }
        if (options.putAlwaysRefuses) throw budgetError();
        map.set(key, value);
      },
      async delete(collection, key) {
        bucket(collection).delete(key);
      },
      async list(collection, opts = {}) {
        const prefix = opts.keyPrefix ?? "";
        const limit = Math.min(opts.limit ?? LIST_DEFAULT, LIST_CLAMP);
        return [...bucket(collection).entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .slice(0, limit)
          .map(([key, value]) => ({ collection, key, value, updatedAt: 0 }));
      },
    },

    contributions: {
      async publish(entityKind, entityId, socket, payload) {
        calls.published.push({ entityKind, entityId, socket, payload });
      },
    },

    panels: {
      async update(panelId, schema) {
        calls.panels.push({ panelId, schema });
      },
    },

    config: {
      async get() {
        return Object.assign({}, config);
      },
      async set(keyOrObject, value) {
        const patch = typeof keyOrObject === "string" ? { [keyOrObject]: value } : keyOrObject;
        config = Object.assign({}, config, patch);
        return Object.assign({}, config);
      },
    },

    schedules: {
      async list() {
        return schedules.slice();
      },
      async create(spec) {
        // The row's id field is `id` — see `PluginSchedule`. A stub that
        // invented `scheduleId` is what let a real `delete(undefined)` ship.
        const row = Object.assign({ id: `sched-${++scheduleSeq}`, pluginId: "decision-log", kind: "cron" }, spec);
        schedules.push(row);
        calls.schedulesCreated.push(row);
        return row;
      },
      async delete(scheduleId) {
        if (typeof scheduleId !== "string" || !scheduleId) {
          const error = new Error('"scheduleId" must be a non-empty string.');
          error.code = "invalid_args";
          throw error;
        }
        schedules = schedules.filter((row) => row.id !== scheduleId);
        calls.schedulesDeleted.push(scheduleId);
      },
    },

    notifications: {
      async post(payload) {
        if (options.notificationsUnavailable) {
          const error = new Error("notification_unavailable");
          error.code = "notification_unavailable";
          throw error;
        }
        calls.notifications.push(payload);
        return { delivered: ["desktop"] };
      },
    },

    actions: {
      async invoke(domain, action, args) {
        calls.invokes.push({ domain, action, args });
        // `lane.list` is project-scoped and answers a plugin with an EMPTY
        // list rather than an error — which is how a bulk lookup silently
        // degraded every subtitle. Stubbed as it really behaves, so a return
        // to it fails here instead of on a user's screen.
        if (domain === "lane" && action === "list") return [];
        if (domain === "lane" && action === "getSummary") {
          if (options.laneSummaryUnavailable) {
            const error = new Error("not_permitted");
            error.code = "not_permitted";
            throw error;
          }
          return lanes.find((lane) => lane.id === (args && args.laneId)) ?? null;
        }
        if (domain === "chat" && action === "getSessionSummary") {
          return sessions[args && args.sessionId] ?? null;
        }
        if (domain === "chat" && action === "emitAdeCard") return { ok: true };
        const error = new Error(`unknown action ${domain}.${action}`);
        error.code = "not_permitted";
        throw error;
      },
    },

    events: {
      handlers: new Map(),
      on(event, handler) {
        host.events.handlers.set(event, handler);
        return () => host.events.handlers.delete(event);
      },
    },

    log(level, message) {
      calls.logs.push({ level, message });
    },
  };

  return { host, calls, store, get config() { return config; }, get schedules() { return schedules; } };
}

/** Let the floating work `activate` starts settle before asserting on it. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { makeHost, settle };
