// Registering the Linear webhook, and the four ways it can refuse.
//
// This replaced a paste box, and the reason it is worth its own test file is
// the failure it exists to prevent: a webhook that Linear happily creates and
// delivers to, whose signing secret ADE does not hold, which reads as healthy
// in Linear's own delivery log and as total silence in ADE. The host declares
// `verify` and FAILS CLOSED, so an unverifiable hook is a hook that drops
// everything.
//
// Every assertion below is about that pair staying together: the hook and the
// secret are created in one act, a hook whose secret is unknowable is rotated
// rather than adopted, and a failure after creation deletes what it made.

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createWebhookSetup, REGISTRATION_COLLECTION, REGISTRATION_KEY, SECRET_NAME } = require("../webhookSetup");
const { createSdk } = require("./support");

const RELAY_URL = "https://relay.example/plugin/ade-linear/linear";

/**
 * A workspace, a connection and a Linear that answers webhook verbs.
 *
 * `connect` is the one dependency that is not the sdk or the api: the refusal
 * this flow has to get right first is an API-KEY connection, which carries no
 * OAuth grant of any kind and which Linear will therefore never post to.
 */
function build(overrides = {}) {
  const sdk = createSdk(overrides.sdk ?? {});
  const hooks = [...(overrides.hooks ?? [])];
  const calls = [];
  const api = {
    async listWebhooks() {
      calls.push(["listWebhooks"]);
      if (overrides.listThrows) throw new Error("rate limited");
      return hooks;
    },
    async createWebhook(params) {
      calls.push(["createWebhook", params]);
      if (overrides.createThrows) throw new Error("Linear refused the webhook.");
      const created = {
        id: "hook-new",
        url: params.url,
        enabled: true,
        label: params.label,
        resourceTypes: params.resourceTypes,
        allPublicTeams: params.allPublicTeams,
      };
      hooks.push(created);
      return created;
    },
    async deleteWebhook(id) {
      calls.push(["deleteWebhook", id]);
      const index = hooks.findIndex((hook) => hook.id === id);
      if (index >= 0) hooks.splice(index, 1);
    },
  };
  const connect = {
    async connectStatus() {
      return {
        connected: overrides.connected !== false,
        clientSource: overrides.clientSource === undefined ? "official" : overrides.clientSource,
      };
    },
  };
  const setup = createWebhookSetup({ sdk, api, connect });
  return { sdk, api, connect, setup, hooks, calls };
}

describe("registering the Linear webhook", () => {
  it("creates the hook and stores its secret in one act", async () => {
    const { sdk, setup, calls } = build();
    const result = await setup.registerWebhook();

    assert.equal(result.ok, true);
    assert.equal(result.registered, true);

    // The secret Linear was given is the secret ADE holds. Linear shows it once
    // and never again, so any other order leaves a hook nothing can verify.
    const created = calls.find(([name]) => name === "createWebhook")[1];
    assert.equal(created.url, RELAY_URL);
    assert.equal(await sdk.secrets.get(SECRET_NAME), created.secret);
    assert.match(created.secret, /^[0-9a-f]{64}$/, "the secret must be 32 random bytes, hex");

    // And it is a real secret rather than a placeholder: two registrations of
    // two workspaces must not share one.
    const second = build();
    await second.setup.registerWebhook();
    assert.notEqual(await second.sdk.secrets.get(SECRET_NAME), created.secret);
  });

  it("asks Linear for the workspace, not for one team", async () => {
    // A hook scoped to a single team delivers nothing for the rest of the
    // workspace, and a reader who registered from ADE asked about their
    // workspace. The resource types are the compiled list.
    const { setup, calls } = build();
    await setup.registerWebhook();
    const created = calls.find(([name]) => name === "createWebhook")[1];
    assert.equal(created.allPublicTeams, true);
    assert.deepEqual(created.resourceTypes, ["Issue", "Comment", "IssueLabel"]);
  });

  it("records the registration so the status can report it", async () => {
    const { sdk, setup } = build();
    await setup.registerWebhook();
    const stored = sdk.collections.value(REGISTRATION_COLLECTION, REGISTRATION_KEY);
    assert.equal(stored.webhookId, "hook-new");
    assert.equal(stored.url, RELAY_URL);
    assert.ok(Date.parse(stored.registeredAt) > 0);
  });

  it("leaves a working registration alone rather than rotating a live secret", async () => {
    const { setup, calls } = build();
    await setup.registerWebhook();
    const before = calls.filter(([name]) => name === "createWebhook").length;

    const again = await setup.registerWebhook();
    assert.equal(again.ok, true);
    assert.match(again.message, /already delivering/);
    assert.equal(calls.filter(([name]) => name === "createWebhook").length, before);
  });

  it("rotates a hook at ADE's URL whose secret it cannot hold", async () => {
    // The secret of a hook this plugin did not create is unknowable. Adopting
    // it would register silence: Linear delivers, the host drops every body for
    // failing verification, and nothing on either side says why.
    const { setup, calls, hooks } = build({
      hooks: [{ id: "hook-stranger", url: RELAY_URL, enabled: true, label: "someone else", resourceTypes: [], allPublicTeams: true }],
    });
    const result = await setup.registerWebhook();
    assert.equal(result.ok, true);
    assert.deepEqual(calls.filter(([name]) => name === "deleteWebhook").map(([, id]) => id), ["hook-stranger"]);
    assert.deepEqual(hooks.map((hook) => hook.id), ["hook-new"]);
  });

  it("leaves a hook pointing somewhere else alone", async () => {
    // Another product's webhook, or ADE's on another machine. Only hooks at
    // THIS endpoint are this flow's to rotate.
    const { setup, calls } = build({
      hooks: [{ id: "hook-elsewhere", url: "https://example.com/other", enabled: true }],
    });
    await setup.registerWebhook();
    assert.equal(calls.some(([name]) => name === "deleteWebhook"), false);
  });

  it("deletes what it made when the secret cannot be stored", async () => {
    // Otherwise a retry leaves a second dead hook in the reader's Linear
    // settings, and the first one keeps delivering bodies ADE drops.
    const secrets = {
      store: new Map(),
      async get() { return null; },
      async set() { throw new Error("keychain locked"); },
      async delete() {},
      async getProviderKey() { return null; },
      async hasProviderKey() { return false; },
    };
    const { setup, calls, hooks } = build({ sdk: { secrets } });
    const result = await setup.registerWebhook();
    assert.equal(result.ok, false);
    assert.match(result.message, /keychain locked/);
    assert.deepEqual(calls.filter(([name]) => name === "deleteWebhook").map(([, id]) => id), ["hook-new"]);
    assert.deepEqual(hooks, []);
  });

  it("refuses an API-key connection in the sentence that names the fix", async () => {
    // Linear delivers a data-change webhook only to an authorization carrying
    // `admin`, and a personal API key carries no OAuth grant at all. Creating
    // the hook anyway would produce an endpoint Linear never posts to.
    const { setup, calls } = build({ clientSource: null });
    const result = await setup.registerWebhook();
    assert.equal(result.ok, false);
    assert.match(result.message, /Sign in with Linear/);
    assert.equal(calls.length, 0, "nothing was spent at Linear");
  });

  it("refuses before a connection exists at all", async () => {
    const { setup } = build({ connected: false });
    const result = await setup.registerWebhook();
    assert.equal(result.ok, false);
    assert.match(result.message, /Connect Linear/);
  });

  it("refuses when this machine hosts no endpoint", async () => {
    const { setup } = build({ sdk: { webhookUrlThrows: true } });
    const result = await setup.registerWebhook();
    assert.equal(result.ok, false);
    assert.match(result.message, /no webhook endpoint/);
  });

  it("answers Linear's own refusal rather than a stack trace", async () => {
    const { setup } = build({ createThrows: true });
    const result = await setup.registerWebhook();
    assert.equal(result.ok, false);
    assert.match(result.message, /Linear refused the webhook/);
  });
});

describe("the webhook status the Automations tile draws", () => {
  it("reports not registered before anything has been created", async () => {
    const { setup } = build();
    const status = await setup.webhookStatus();
    assert.equal(status.registered, false);
    assert.equal(status.canRegister, true);
    assert.equal(status.status, "Not registered");
    assert.equal(status.url, RELAY_URL);
  });

  it("reports registered, and carries the host's delivery ledger", async () => {
    // Registration and DELIVERY are different facts. A hook can exist and
    // deliver nothing; the ledger is the only thing that can say so.
    const { setup } = build({
      sdk: {
        webhookStatus: {
          lastReceivedAt: "2026-09-01T12:00:34.000Z",
          pendingDeliveries: 2,
          lastError: "relay timed out",
        },
      },
    });
    await setup.registerWebhook();
    const status = await setup.webhookStatus();
    assert.equal(status.registered, true);
    assert.equal(status.webhookId, "hook-new");
    assert.equal(status.lastEvent, "2026-09-01 12:00 UTC");
    assert.equal(status.pendingDeliveries, 2);
    assert.equal(status.error, "relay timed out");
  });

  it("says an API key will never receive, whatever else is true", async () => {
    const { setup } = build({ clientSource: null });
    const status = await setup.webhookStatus();
    assert.equal(status.webhooksPossible, false);
    assert.equal(status.canRegister, false);
    assert.match(status.status, /API key/);
  });

  it("is not registered when the secret is gone, whatever the record says", async () => {
    // The record and the secret are one fact in two places. With the secret
    // missing every delivery is dropped, so a tile drawing "Registered" from
    // the record alone would be reporting a working endpoint that works for
    // nothing.
    const { sdk, setup } = build();
    await setup.registerWebhook();
    await sdk.secrets.delete(SECRET_NAME);
    const status = await setup.webhookStatus();
    assert.equal(status.registered, false);
  });

  it("reads no ledger when there is no endpoint to deliver to", async () => {
    // A ledger read with no URL answers zeros, and a tile drawing "0 unacked"
    // beside "not set up" reads as a healthy silence.
    const { sdk, setup } = build({ sdk: { webhookUrlThrows: true } });
    const status = await setup.webhookStatus();
    assert.equal(status.url, null);
    assert.equal(status.lastEvent, null);
    assert.equal(sdk.calls.some(([name]) => name === "webhooks.status"), false);
  });
});

describe("removing the webhook", () => {
  it("deletes the hook, the secret and the record together", async () => {
    const { sdk, setup, calls, hooks } = build();
    await setup.registerWebhook();
    const result = await setup.unregisterWebhook();

    assert.equal(result.ok, true);
    assert.equal(result.registered, false);
    assert.deepEqual(calls.filter(([name]) => name === "deleteWebhook").map(([, id]) => id), ["hook-new"]);
    assert.deepEqual(hooks, []);
    assert.equal(await sdk.secrets.get(SECRET_NAME), null);
    assert.equal(sdk.collections.value(REGISTRATION_COLLECTION, REGISTRATION_KEY), null);
  });

  it("still forgets the secret when Linear has already dropped the hook", async () => {
    // A hook deleted in Linear's own settings is not an error here. The record
    // and the secret still have to go, or the tile keeps claiming a
    // registration that does not exist.
    const { sdk, setup } = build();
    await setup.registerWebhook();
    const failing = createWebhookSetup({
      sdk,
      api: { async deleteWebhook() { throw new Error("no such webhook"); } },
      connect: { async connectStatus() { return { connected: true, clientSource: "official" }; } },
    });
    const result = await failing.unregisterWebhook();
    assert.equal(result.ok, true);
    assert.equal(await sdk.secrets.get(SECRET_NAME), null);
  });
});
