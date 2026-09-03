// The action table against its two contracts: the manifest, and the page.
//
// `plugin.json` names an `actionId` in nine places and `page/test/fakeBridge.ts`
// names fourteen more. Both are files this plugin does not own the other half
// of — the host dispatches the first set, the page invokes the second — and a
// typo in either is a button that does nothing, with nothing anywhere failing.
// So both are read here and checked against the real table.
//
// Nothing in this file calls `activate`: the whole point is that these ids
// resolve at LOAD, before any host has bound anything, because a page can open
// the instant its tab is drawn.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const plugin = require("../index");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));

/**
 * Every action id the manifest names, wherever it names one.
 *
 * Walked rather than listed, so a socket, tool or step added to the manifest
 * without a handler fails here instead of at the first press.
 */
function manifestActionIds() {
  const ids = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  };
  for (const panel of manifest.panels ?? []) {
    add(panel.refreshAction);
    add(panel.viewAction);
  }
  for (const socket of manifest.sockets ?? []) {
    add(socket.actionId);
    for (const entry of socket.menu ?? []) add(entry.actionId);
    add(socket.webhook?.statusAction);
    add(socket.webhook?.registerAction);
  }
  for (const tool of manifest.tools ?? []) add(tool.action);
  for (const step of manifest.automationSteps ?? []) add(step.action);
  for (const provider of manifest.searchProviders ?? []) add(provider.action);
  for (const word of manifest.cli ?? []) add(word);
  return [...ids].sort();
}

/**
 * Every action id `page/test/fakeBridge.ts` scripts.
 *
 * Read out of the fake rather than copied, because the fake is the contract:
 * a page that invokes an id it does not script fails its own test, and an id
 * it scripts that this table does not answer fails here. Neither half owns it.
 */
function fakeBridgeActionIds() {
  const source = fs.readFileSync(path.join(ROOT, "page/test/fakeBridge.ts"), "utf8");
  const start = source.indexOf("const actions: Record<");
  assert.ok(start > 0, "fakeBridge.ts no longer declares an `actions` map");
  // Bounded to the map's own closing brace — the only line at two spaces —
  // so keys of the objects declared after it are not mistaken for actions.
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n  };", open);
  assert.ok(close > open, "fakeBridge.ts's `actions` map is no longer a two-space block");
  const body = source.slice(open, close);
  const ids = new Set();
  for (const match of body.matchAll(/^ {4}([A-Za-z][A-Za-z0-9_]*)\s*:/gmu)) ids.add(match[1]);
  return [...ids].sort();
}

describe("the manifest's action ids", () => {
  it("every one of them resolves before activate has run", () => {
    const missing = manifestActionIds().filter((id) => typeof plugin.actions[id] !== "function");
    assert.deepEqual(missing, [], `the manifest names handlers this plugin does not have: ${missing.join(", ")}`);
  });

  it("names the machine-entry row's action, which is what Enter invokes", () => {
    const row = (manifest.sockets ?? []).find((socket) => socket.socket === "machine-entry");
    assert.equal(row.actionId, "launchFromComposer");
    assert.equal(row.ownsSend, true);
    // The Advanced affordance and the action's own non-send answer must point
    // at the same page, or the two doorways open different forms.
    assert.equal(row.advancedSurfaceId, "launch");
  });

  it("declares every surface an action can ask to open", () => {
    const surfaces = new Set((manifest.surfaces ?? []).filter((s) => s.kind === "webview").map((s) => s.id));
    assert.deepEqual([...surfaces].sort(), ["agent", "fleet", "launch"]);
    for (const socket of manifest.sockets ?? []) {
      if (!socket.webviewSurfaceId) continue;
      assert.ok(surfaces.has(socket.webviewSurfaceId), `${socket.id} points at an undeclared surface`);
    }
  });

  it("declares the four chat capabilities that drive stop, follow-up and artifacts", () => {
    // Nothing new: `handleTurn`, `handleInterrupt`, `hydrate` and `setArtifacts`
    // are what these four switch on, and all four already existed.
    const runtime = (manifest.chatRuntimes ?? []).find((entry) => entry.id === "cloud-agent");
    assert.deepEqual(runtime.capabilities, {
      followUp: true,
      interrupt: true,
      hydrate: true,
      artifacts: true,
    });
    // Cursor owns the name of a Cursor agent.
    assert.equal(runtime.renameLock, true);
  });

  it("keeps every CLI word the 1.x plugin published", () => {
    // A removed word is a script somebody wrote that stops working.
    assert.deepEqual(manifest.cli, ["agents", "runs", "artifacts", "repos", "me"]);
  });
});

describe("the page's action ids", () => {
  it("answers exactly what the fake bridge scripts", () => {
    const scripted = fakeBridgeActionIds();
    assert.deepEqual(scripted, [
      "pageAckBadge", "pageAgent", "pageArchiveAgent", "pageConnection", "pageCopyWebhookUrl",
      "pageDeleteAgent", "pageFleet", "pageFollowUp", "pageLaunch", "pageLaunchContext",
      "pageOpenInAde", "pagePullIntoLane", "pageStopRun", "pageUnarchiveAgent",
    ]);
    const missing = scripted.filter((id) => typeof plugin.actions[id] !== "function");
    assert.deepEqual(missing, [], `the page invokes handlers this plugin does not answer: ${missing.join(", ")}`);
    // And nothing extra: a `page*` handler nothing scripts is dead code the
    // seam test would never catch.
    const ours = Object.keys(plugin.actions).filter((id) => id.startsWith("page")).sort();
    assert.deepEqual(ours, scripted);
  });

  it("is disjoint from the manifest's table, so neither can shadow the other", () => {
    const manifestIds = new Set(manifestActionIds());
    const shared = Object.keys(plugin.__internals.pageActions).filter((id) => manifestIds.has(id));
    assert.deepEqual(shared, []);
  });
});

describe("the machine-entry row's two gestures", () => {
  it("opens the launch page over the composer when it was not a Send", async () => {
    // Selecting the row is a mode and invokes nothing. Anything that is not
    // Enter — Advanced, a palette press, a client with no composer — is a
    // request to open the plugin's own form.
    for (const args of [{}, { send: false }, { context: { kind: "composer", draft: "fix it" } }]) {
      const result = await plugin.actions.launchFromComposer(args);
      assert.deepEqual(result, { openWebview: { surfaceId: "launch", placement: "picker" } });
    }
  });
});

describe("Cursor's page ceilings", () => {
  it("never asks Cursor for a page above its own limit", () => {
    const { CURSOR_MAX_PAGE_LIMIT, FLEET_MAX_AGENTS, clampPageLimit, clampFleetBudget } = require("../repoMatch");
    // `limit` is a PAGE size and Cursor refuses anything above 100 with
    // `[validation_error] Limit must be at most 100`.
    assert.equal(CURSOR_MAX_PAGE_LIMIT, 100);
    assert.equal(clampPageLimit(200), 100);
    assert.equal(clampPageLimit(FLEET_MAX_AGENTS), 100);
    assert.equal(clampPageLimit(0), 1);
    assert.equal(clampPageLimit(undefined), undefined);
    // `budget` is a whole-read ROW count, walked across pages, and is never
    // sent to Cursor as a `limit`.
    assert.equal(clampFleetBudget(1000), 200);
    assert.equal(clampFleetBudget(undefined), 100);
  });

  it("clamps the runs page the CLI and the detail pane ask for", async () => {
    const { createCursorApi } = require("../cursorApi");
    const urls = [];
    const api = createCursorApi({
      getApiKey: async () => "key",
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
      },
    });
    await api.listRuns("a1", { limit: 500 });
    await api.listAgents({ limit: 200 });
    for (const url of urls) assert.match(url, /limit=100(&|$)/, url);
  });
});

/* ── The launch, end to end ──────────────────────────────────────────────── */

/**
 * A whole host, thin enough to read and complete enough to activate against.
 *
 * The launch is the one path in this plugin that touches everything — the
 * lanes, git, Cursor's repositories, Cursor's catalog, the create, the chat
 * seam, the fleet refresh — so the only honest test of it drives the real
 * `activate` and presses the real action.
 */
function fakeHost(options = {}) {
  const calls = [];
  const collections = new Map(Object.entries(options.collections ?? {}));
  const record = (name, args) => { calls.push({ name, args }); };
  const fetched = [];

  const sdk = {
    log: () => {},
    events: { on: () => () => {} },
    panels: { update: async () => {} },
    contributions: { publish: async () => {} },
    config: { get: async () => ({ autoOpenPr: options.autoOpenPr === true }) },
    secrets: {
      getProviderKey: async () => (options.noKey ? "" : "key_cursor_test"),
      get: async (name) => options.secretValues?.[name] ?? null,
    },
    clipboard: { write: async () => {} },
    webhooks: { status: async () => null, url: async () => null, ack: async () => {} },
    automations: { emitTrigger: async () => {} },
    collections: {
      get: async (collection, key) => collections.get(`${collection}/${key}`) ?? null,
      put: async (collection, key, value) => { collections.set(`${collection}/${key}`, value); },
      list: async () => [],
      delete: async () => {},
    },
    chat: {
      createSession: async (input) => {
        record("createSession", input);
        if (options.createSessionThrows) throw options.createSessionThrows;
        return { sessionId: "session-1", created: true };
      },
      emitStatus: async () => {},
      hydrate: async (sessionId, entries) => ({ accepted: entries.length, skipped: 0 }),
      attachBranch: async () => {},
      setArtifacts: async () => {},
    },
    actions: {
      invoke: async (domain, action, args) => {
        record(`${domain}.${action}`, args);
        if (domain === "lane" && action === "list") {
          return options.lanes ?? [{ id: "lane-1", name: "sync-fix", branchRef: "ade/sync-fix" }];
        }
        if (domain === "git" && action === "getOriginRemote") {
          return { remoteUrl: "git@github.com:acme/app.git", branch: "ade/sync-fix" };
        }
        if (domain === "git" && action === "getSyncStatus") {
          return options.sync ?? { hasUpstream: true, diverged: false, ahead: 0, behind: 0 };
        }
        if (domain === "git" && action === "push") {
          if (options.pushThrows) throw options.pushThrows;
          return { ok: true };
        }
        if (domain === "git" && action === "getOpenPrForBranch") {
          return options.openPr ?? { prUrl: null, prNumber: null, title: null };
        }
        return null;
      },
    },
  };

  // The whole Cursor REST surface the launch touches, over a fake `fetch`.
  const fetchImpl = async (url, init) => {
    fetched.push({ url, init });
    const body = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    if (url.endsWith("/v1/repositories")) return body({ items: [{ url: "https://github.com/acme/app" }] });
    if (url.endsWith("/v1/models")) return body({ items: [{ id: "composer-2" }] });
    if (url.endsWith("/v1/agents") && init.method === "POST") {
      if (options.createThrows) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: options.createThrows } }) };
      }
      return body({ agent: { id: "bc_new1" } });
    }
    if (/\/v1\/agents\/[^/]+$/.test(url)) return body({ id: "bc_new1", name: "fix the sync test" });
    if (url.includes("/runs")) return body({ items: [] });
    if (url.includes("/v1/agents?")) return body({ items: [] });
    return body({ items: [] });
  };

  return { sdk, calls, fetched, collections, fetchImpl, of: (name) => calls.filter((call) => call.name === name) };
}

async function activated(options = {}) {
  const host = fakeHost(options);
  // The plugin builds its Cursor client inside `activate`, so the fake `fetch`
  // is installed on the global the client reads.
  const realFetch = globalThis.fetch;
  globalThis.fetch = host.fetchImpl;
  try {
    await plugin.activate(host.sdk);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { host, restore: () => { globalThis.fetch = realFetch; } };
}

async function withFetch(host, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = host.fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("pressing Enter on the Cursor Cloud machine row", () => {
  it("pushes origin, resolves the PR fields, creates the agent and clears the draft", async () => {
    const { host } = await activated({ sync: { hasUpstream: true, diverged: false, ahead: 2, behind: 0 } });
    const result = await withFetch(host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft: "  fix the sync test  ", modelId: "composer-2" },
    }));
    await plugin.deactivate();

    assert.equal(result.message, "Launched on Cursor Cloud.");
    // The draft is cleared, which is how the reader knows it went.
    assert.deepEqual(result.composer, { replaceText: "" });
    // A locally-ahead branch is pushed before Cursor clones it.
    assert.deepEqual(host.of("git.push").map((call) => call.args), [{ laneId: "lane-1" }]);

    const create = host.fetched.find((call) => call.init?.method === "POST");
    assert.equal(JSON.parse(create.init.body).prompt.text, "fix the sync test");
    assert.deepEqual(JSON.parse(create.init.body).repos, [
      { url: "https://github.com/acme/app", startingRef: "ade/sync-fix" },
    ]);
    assert.equal(JSON.parse(create.init.body).workOnCurrentBranch, true);
    assert.equal(JSON.parse(create.init.body).skipReviewerRequest, true);
    assert.equal(JSON.parse(create.init.body).autoCreatePR, undefined);
    // Every create carries an idempotency key, so a retry adopts.
    assert.match(create.init.headers["Idempotency-Key"], /.+/);
    // And the agent became a chat.
    assert.equal(host.of("createSession").length, 1);
  });

  it("attaches to a PR the branch already has instead of asking for a second", async () => {
    const { host } = await activated({
      autoOpenPr: true,
      openPr: { prUrl: "https://github.com/acme/app/pull/7", prNumber: 7, title: "Fix sync" },
    });
    await withFetch(host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft: "fix it", modelId: "composer-2" },
    }));
    await plugin.deactivate();

    const body = JSON.parse(host.fetched.find((call) => call.init?.method === "POST").init.body);
    assert.equal(body.prUrl, "https://github.com/acme/app/pull/7");
    assert.equal(body.autoCreatePR, undefined, "Auto-PR is off when a PR already exists");
  });

  it("blocks a diverged branch rather than pushing over origin", async () => {
    const { host } = await activated({ sync: { hasUpstream: true, diverged: true, ahead: 1, behind: 1 } });
    const result = await withFetch(host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft: "fix it", modelId: "composer-2" },
    }));
    await plugin.deactivate();

    assert.equal(result.ok, false);
    assert.match(result.message, /behind origin and also has local commits/);
    assert.deepEqual(host.of("git.push"), []);
    // Nothing was created, and the draft is still on screen.
    assert.equal(host.fetched.some((call) => call.init?.method === "POST"), false);
    assert.equal(result.composer, undefined);
  });

  it("says the composer's own sentence when no Cursor model is picked", async () => {
    const { host } = await activated();
    const result = await withFetch(host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft: "fix it", modelId: "gpt-9" },
    }));
    await plugin.deactivate();
    assert.deepEqual(result, { ok: false, message: "Choose a Cursor Cloud model first" });
  });

  it("keeps the idempotency key when Cursor refuses, and drops it on success", async () => {
    const draft = `retry me ${Date.now()}`;
    const refused = await activated({ createThrows: "temporarily unavailable" });
    const failure = await withFetch(refused.host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft, modelId: "composer-2" },
    }));
    await plugin.deactivate();
    assert.equal(failure.ok, false);
    const firstKey = refused.host.fetched.find((call) => call.init?.method === "POST").init.headers["Idempotency-Key"];

    // The retry reuses the key, so Cursor answers with the agent it may already
    // have made rather than starting a second one on the same branch.
    const retry = await activated();
    await withFetch(retry.host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft, modelId: "composer-2" },
    }));
    const retryKey = retry.host.fetched.find((call) => call.init?.method === "POST").init.headers["Idempotency-Key"];
    assert.equal(retryKey, firstKey);

    // That launch succeeded, so the next send of the same draft is a NEW launch.
    const again = await activated();
    await withFetch(again.host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft, modelId: "composer-2" },
    }));
    await plugin.deactivate();
    const thirdKey = again.host.fetched.find((call) => call.init?.method === "POST").init.headers["Idempotency-Key"];
    assert.notEqual(thirdKey, firstKey);
  });

  it("still reports success when Cursor accepted the agent but ADE could not bind a chat", async () => {
    const { host } = await activated({ createSessionThrows: new Error("that lane is gone") });
    const result = await withFetch(host, () => plugin.actions.launchFromComposer({
      send: true,
      context: { kind: "composer", laneId: "lane-1", draft: "fix it", modelId: "composer-2" },
    }));
    await plugin.deactivate();
    // The work IS under way. "It failed" would send the reader looking for it.
    assert.equal(result.ok, undefined);
    assert.equal(result.message, "Launched on Cursor Cloud. Open it from the fleet to follow along.");
    assert.deepEqual(result.composer, { replaceText: "" });
  });
});

describe("deactivating while a refresh is in flight", () => {
  it("does not dereference a client that is already gone", async () => {
    // Almost every caller of `refreshFleet` is a fire-and-forget
    // `void refreshFleet()`, so `deactivate` routinely lands between two of its
    // awaits. Re-reading the module binding there threw a TypeError into an
    // unhandled rejection, which no surface would ever have reported.
    const { host } = await activated();
    const pending = withFetch(host, () => plugin.actions.refreshFleet({}));
    await plugin.deactivate();
    await assert.doesNotReject(pending);
  });
});
