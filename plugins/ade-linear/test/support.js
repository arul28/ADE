// Fakes for the two things this plugin cannot have in a test: ADE and Linear.
//
// Both are hand-written rather than mocked. A recording fake is what lets a
// test assert the ORDER of a sequence — that the ack came after the refetch,
// that the delete half of a replace ran after the write half — which is where
// this plugin's real bugs would live.

"use strict";

/**
 * An in-memory stand-in for `ade.collections`.
 *
 * Enforces the two rules the host enforces and nothing else: a write to an
 * UNDECLARED collection rejects (`pluginSdkServer.ts` does, and a panel bound
 * to rows the plugin may not store is an empty list with no error anywhere),
 * and `list` returns rows sorted by key, which is the property the three key
 * spaces depend on.
 */
function createCollections(declared) {
  const names = new Set(declared ?? [
    "issues", "comments", "teams", "states", "projects", "people", "viewer", "deliveries",
  ]);
  const store = new Map();
  const calls = [];

  function require_(collection) {
    if (!names.has(collection)) {
      const error = new Error(`Collection "${collection}" is not declared.`);
      error.code = "not_permitted";
      throw error;
    }
    if (!store.has(collection)) store.set(collection, new Map());
    return store.get(collection);
  }

  return {
    calls,
    raw: store,
    async get(collection, key) {
      calls.push(["get", collection, key]);
      return require_(collection).get(key) ?? null;
    },
    async put(collection, key, value) {
      calls.push(["put", collection, key]);
      require_(collection).set(key, value);
    },
    async delete(collection, key) {
      calls.push(["delete", collection, key]);
      require_(collection).delete(key);
    },
    async list(collection, options = {}) {
      calls.push(["list", collection, options.keyPrefix ?? null]);
      const rows = [...require_(collection).entries()]
        .filter(([key]) => !options.keyPrefix || key.startsWith(options.keyPrefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ collection, key, value, updatedAt: "2026-08-31T00:00:00.000Z" }));
      return typeof options.limit === "number" ? rows.slice(0, options.limit) : rows;
    },
    /** Every key of one collection, in sort order. The assertion most tests want. */
    keys(collection) {
      return [...(store.get(collection)?.keys() ?? [])].sort();
    },
    value(collection, key) {
      return store.get(collection)?.get(key) ?? null;
    },
  };
}

/** An in-memory `ade.secrets`, with the provider-key half a plugin may not write. */
function createSecrets(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(name) {
      return store.has(name) ? store.get(name) : null;
    },
    async set(name, value) {
      store.set(name, value);
    },
    async delete(name) {
      store.delete(name);
    },
    async getProviderKey() {
      return null;
    },
    async hasProviderKey() {
      return false;
    },
  };
}

/**
 * A fake `ade` global.
 *
 * Every verb records its call so a test can assert what happened and in which
 * order. Overrides replace a whole namespace, which is what a test that cares
 * about one verb wants.
 */
function createSdk(overrides = {}) {
  const calls = [];
  const collections = overrides.collections ?? createCollections();
  const secrets = overrides.secrets ?? createSecrets();
  const memory = new Map();
  const config = { ...(overrides.config ?? {}) };
  const panels = new Map();

  const sdk = {
    pluginId: "ade-linear",
    sdkVersion: 0,
    calls,
    collections,
    secrets,
    panels: {
      async update(panelId, schema) {
        calls.push(["panels.update", panelId]);
        panels.set(panelId, schema);
      },
      get: (panelId) => panels.get(panelId) ?? null,
    },
    config: {
      async get() {
        return { ...config };
      },
      async set(key, value) {
        if (typeof key === "object") Object.assign(config, key);
        else config[key] = value;
        return { ...config };
      },
    },
    memory: {
      async get(key) {
        return memory.has(key) ? memory.get(key) : null;
      },
      async set(key, value) {
        memory.set(key, value);
      },
      async delete(key) {
        memory.delete(key);
      },
      async list() {
        return [];
      },
    },
    actions: {
      async invoke(domain, action, args) {
        calls.push([`actions.${domain}.${action}`, args]);
        const handler = overrides.actions?.[`${domain}.${action}`];
        if (!handler) throw new Error(`No fake for ${domain}.${action}`);
        return await handler(args);
      },
    },
    lanes: {
      async list() {
        calls.push(["lanes.list"]);
        return overrides.lanes ?? [];
      },
      async get(laneId) {
        calls.push(["lanes.get", laneId]);
        return (overrides.lanes ?? []).find((lane) => lane.id === laneId) ?? null;
      },
      async listSessionIssues(laneId) {
        calls.push(["lanes.listSessionIssues", laneId]);
        if (overrides.listSessionIssuesThrows) throw overrides.listSessionIssuesThrows;
        return (overrides.sessionIssues ?? {})[laneId] ?? [];
      },
      async linkIssue(input) {
        calls.push(["lanes.linkIssue", input]);
        if (overrides.linkIssueThrows) throw new Error("link refused");
        return { issue: { ...input.issue, pluginId: "ade-linear" }, role: input.role ?? "referenced" };
      },
      async unlinkIssue() {
        return true;
      },
    },
    contributions: {
      async publish(kind, id, socket, payload) {
        calls.push(["contributions.publish", kind, id, socket, payload?.id ?? null]);
      },
    },
    automations: {
      async emitTrigger(input) {
        calls.push(["automations.emitTrigger", input.triggerId]);
        if (overrides.emitTriggerThrows) throw new Error("trigger refused");
      },
    },
    webhooks: {
      async url(channel) {
        calls.push(["webhooks.url", channel]);
        if (overrides.webhookUrlThrows) {
          const error = new Error("no ingress");
          error.code = "unsupported_method";
          throw error;
        }
        return `https://relay.example/plugin/ade-linear/${channel}`;
      },
      async ack(deliveryId) {
        calls.push(["webhooks.ack", deliveryId]);
      },
      async status() {
        calls.push(["webhooks.status"]);
        if (overrides.webhookStatusThrows) {
          const error = new Error("no ingress");
          error.code = "unsupported_method";
          throw error;
        }
        return overrides.webhookStatus ?? {
          pluginId: "ade-linear",
          state: "unconfigured",
          relayBaseUrl: "https://relay.example",
          channels: [],
          lastReceivedAt: null,
          lastPolledAt: null,
          lastError: null,
          pendingDeliveries: 0,
          abandonedDeliveries: 0,
        };
      },
    },
    auth: {
      async beginSession(input) {
        calls.push(["auth.beginSession", input.sessionId, input.params]);
        if (overrides.beginSessionThrows) throw overrides.beginSessionThrows;
        return {
          sessionId: input.sessionId,
          attempt: overrides.attempt ?? "attempt-1",
          transport: "loopback",
          redirectUri: "http://127.0.0.1:19837/oauth/callback",
        };
      },
      async cancelSession(sessionId) {
        calls.push(["auth.cancelSession", sessionId]);
      },
      /**
       * The official-client broker, refused for every plugin that does not own
       * the built-in surface. `overrides.officialClient === null` models a host
       * that lends nothing, which is an ordinary state and not a failure.
       */
      async officialClient(provider) {
        calls.push(["auth.officialClient", provider]);
        if (overrides.officialClientThrows) throw overrides.officialClientThrows;
        if (overrides.officialClient === null) {
          const error = new Error("no official client");
          error.code = "not_permitted";
          throw error;
        }
        return overrides.officialClient ?? {
          provider,
          clientId: "ade-official-client",
          scopes: ["read", "write", "admin"],
        };
      },
      async requestHandoff(builtin) {
        calls.push(["auth.requestHandoff", builtin]);
        return overrides.handoff ?? { builtin, status: "empty", secretNames: [] };
      },
    },
    events: {
      on(event, listener) {
        calls.push(["events.on", event]);
        (sdk.listeners[event] ??= []).push(listener);
        return () => {
          sdk.listeners[event] = (sdk.listeners[event] ?? []).filter((entry) => entry !== listener);
        };
      },
    },
    listeners: {},
    log(level, message) {
      calls.push(["log", level, message]);
    },
  };
  return sdk;
}

/** A Linear GraphQL issue node, with everything `ISSUE_FIELDS` selects. */
function issueNode(overrides = {}) {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "ENG-1",
    title: overrides.title ?? "Fix the thing",
    description: overrides.description ?? "Some body.",
    url: overrides.url ?? "https://linear.app/acme/issue/ENG-1/fix-the-thing",
    priority: overrides.priority ?? 2,
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-20T00:00:00.000Z",
    dueDate: overrides.dueDate ?? null,
    estimate: overrides.estimate ?? null,
    archivedAt: null,
    startedAt: overrides.startedAt ?? null,
    completedAt: null,
    canceledAt: overrides.canceledAt ?? null,
    cycle: overrides.cycle === null ? null : (overrides.cycle ?? null),
    project: overrides.project === null ? null : (overrides.project ?? { id: "proj-1", name: "Platform" }),
    team: overrides.team ?? { id: "team-1", key: "ENG", name: "Engineering" },
    state: overrides.state ?? { id: "state-started", name: "In Progress", type: "started" },
    assignee: overrides.assignee === null ? null : (overrides.assignee ?? { id: "user-1", name: "Ada", displayName: "Ada L" }),
    creator: overrides.creator ?? { id: "user-2", name: "Grace", displayName: "Grace H" },
    labels: overrides.labels ?? { nodes: [{ id: "label-1", name: "bug", color: "#f00" }] },
    children: overrides.children ?? { nodes: [] },
    // Linear's inverse relations: the ones where THIS issue is the blocked
    // side, so `issue` on a `blocks` relation is the thing in the way.
    inverseRelations: overrides.inverseRelations ?? { nodes: [] },
  };
}

/** A Linear api client whose every verb is a stub the test can replace. */
function createApi(overrides = {}) {
  return {
    async searchAllIssues() {
      return [];
    },
    async searchIssues() {
      return { nodes: [], hasNextPage: false, endCursor: null };
    },
    async fetchIssueById() {
      return null;
    },
    async fetchIssueComments() {
      return [];
    },
    async listTeamsAndStates() {
      return [];
    },
    async listLabels() {
      return [];
    },
    async getConnectionIdentity() {
      return {
        viewerId: "user-1",
        viewerName: "Ada L",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationUrlKey: "acme",
        organizationLogoUrl: null,
      };
    },
    async readCredential() {
      return { token: "lin_api_abc", authMode: "manual", expiresAt: null, refreshToken: null, clientId: null };
    },
    async updateIssueState() {},
    async updateIssueAssignee() {},
    async createComment() {
      return "comment-1";
    },
    async addLabel() {
      return "label-1";
    },
    async request() {
      return {};
    },
    async writeToken() {},
    ...overrides,
  };
}

/** A `Response`-alike for a fetch fake. */
function response(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

module.exports = {
  createApi,
  createCollections,
  createSdk,
  createSecrets,
  issueNode,
  response,
};
