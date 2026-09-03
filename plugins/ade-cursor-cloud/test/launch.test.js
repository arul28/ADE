"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  agentNameFromPrompt,
  buildCreateRequest,
  clearIdempotencyKey,
  collectSecretValues,
  ensureExistingLaneOriginReady,
  findConnectedRepo,
  idempotencyKeyFor,
  isInjectableSecretName,
  laneSecretsKey,
  launchUnavailableReason,
  readComposerLaunch,
  readLaunchForm,
  resolvePrCreateFields,
} = require("../launch");
const { buildFleetPanel, buildLaunchPanel, fleetFilterRow, fleetWhere, unavailableReason } = require("../panels");

describe("reading the launch form", () => {
  it("reads the fields the form declared", () => {
    const form = readLaunchForm({
      prompt: "  fix the flaky sync test  ",
      laneId: "lane-7",
      model: "composer-2",
      openPr: true,
      rememberSecretNames: true,
      "secret:DATABASE_URL": true,
      "secret:UNUSED": false,
      context: { kind: "composer" },
    });

    assert.equal(form.prompt, "fix the flaky sync test");
    assert.equal(form.laneId, "lane-7");
    assert.equal(form.model, "composer-2");
    assert.equal(form.reasoningEffort, null);
    assert.equal(form.fastMode, null);
    assert.equal(form.openPr, true);
    assert.deepEqual(form.secretNames, ["DATABASE_URL"]);
  });

  it("treats an untouched model select as Cursor's default, not as a model named ''", () => {
    assert.equal(readLaunchForm({ model: "" }).model, null);
    assert.equal(readLaunchForm({}).model, null);
  });

  it("reads speed as a tri-state so an untouched control is not 'standard'", () => {
    assert.equal(readLaunchForm({}).fastMode, null);
    assert.equal(readLaunchForm({ fastMode: "" }).fastMode, null);
    assert.equal(readLaunchForm({ fastMode: "fast" }).fastMode, true);
    assert.equal(readLaunchForm({ fastMode: "standard" }).fastMode, false);
    assert.equal(readLaunchForm({ reasoningEffort: "high" }).reasoningEffort, "high");
  });

  it("reads a composer Send as the same fields, without turning Fast-off into standard", () => {
    const form = readComposerLaunch({
      send: true,
      context: {
        kind: "composer",
        laneId: "lane-7",
        draft: "  fix the flaky sync test  ",
        modelId: "composer-2",
        reasoningEffort: "high",
        fastMode: false,
      },
    });
    assert.equal(form.prompt, "fix the flaky sync test");
    assert.equal(form.laneId, "lane-7");
    assert.equal(form.model, "composer-2");
    assert.equal(form.reasoningEffort, "high");
    assert.equal(form.fastMode, null);
    assert.equal(readComposerLaunch({
      context: { kind: "composer", draft: "go", fastMode: true },
    }).fastMode, true);
  });

  it("refuses a secret in Cursor's own namespace", () => {
    // A user's CURSOR_API_KEY shadowing the agent's own credential breaks the
    // run in a way nothing explains.
    assert.equal(isInjectableSecretName("CURSOR_API_KEY"), false);
    assert.equal(isInjectableSecretName("cursor_api_key"), false);
    assert.equal(isInjectableSecretName("DATABASE_URL"), true);
    assert.deepEqual(readLaunchForm({ "secret:CURSOR_API_KEY": true }).secretNames, []);
  });
});

describe("finding the repository Cursor can clone", () => {
  const connected = [{ url: "https://github.com/acme/app" }, { url: "https://github.com/acme/other" }];

  it("matches a lane's SSH remote to Cursor's HTTPS listing", () => {
    assert.equal(findConnectedRepo(connected, "git@github.com:acme/app.git"), "https://github.com/acme/app");
  });

  it("answers null for a repo Cursor has never seen", () => {
    assert.equal(findConnectedRepo(connected, "git@github.com:acme/secret.git"), null);
    assert.equal(findConnectedRepo(connected, null), null);
    assert.equal(findConnectedRepo(null, "git@github.com:acme/app.git"), null);
  });

  it("names which of the two is missing", () => {
    assert.match(unavailableReason({ laneRemote: null }), /no GitHub remote/);
    assert.match(unavailableReason({ laneRemote: "x", repoConnected: false }), /not connected to Cursor/);
    assert.equal(unavailableReason({ laneRemote: "x", repoConnected: true }), null);
    assert.match(unavailableReason({ probe: "error", message: "429" }), /429/);
  });
});

describe("the create request", () => {
  it("sends only fields POST /v1/agents accepts", () => {
    const request = buildCreateRequest({
      prompt: "fix it",
      repoUrl: "https://github.com/acme/app",
      branch: "ade/fix",
      model: "composer-2",
      openPr: true,
      envVars: { DATABASE_URL: "postgres://x" },
      name: "fix it",
    });

    assert.deepEqual(request, {
      prompt: { text: "fix it" },
      repos: [{ url: "https://github.com/acme/app", startingRef: "ade/fix" }],
      name: "fix it",
      model: { id: "composer-2" },
      autoCreatePR: true,
      envVars: { DATABASE_URL: "postgres://x" },
    });
    // `metadata` fails create outright with `[feature_unavailable] API v1 agent
    // metadata is not enabled`, which is why the session binding lives in this
    // plugin's own collection instead.
    assert.equal("metadata" in request, false);
    assert.equal("webhook" in request, false);
  });

  it("sends model as { id, params } when the form resolved them", () => {
    const request = buildCreateRequest({
      prompt: "go",
      repoUrl: "https://github.com/acme/app",
      model: { id: "composer-2", params: [{ id: "reasoning", value: "high" }] },
    });
    assert.deepEqual(request.model, { id: "composer-2", params: [{ id: "reasoning", value: "high" }] });
  });

  it("omits everything the user did not choose", () => {
    const request = buildCreateRequest({ prompt: "go", repoUrl: "https://github.com/acme/app" });
    assert.deepEqual(request, { prompt: { text: "go" }, repos: [{ url: "https://github.com/acme/app" }] });
  });

  it("skips a secret with no stored value rather than sending it empty", async () => {
    const stored = { DATABASE_URL: "postgres://x", EMPTY: "" };
    const envVars = await collectSecretValues(
      async (name) => stored[name] ?? null,
      ["DATABASE_URL", "EMPTY", "MISSING", "CURSOR_API_KEY"],
    );
    assert.deepEqual(envVars, { DATABASE_URL: "postgres://x" });
  });

  it("names the agent after the prompt's first line", () => {
    assert.equal(agentNameFromPrompt("Fix the sync test\nand the lint"), "Fix the sync test");
    assert.equal(agentNameFromPrompt(""), "Cursor Cloud agent");
    assert.equal(agentNameFromPrompt("x".repeat(200)).length, 60);
  });

  it("keys a lane's remembered secret names by lane", () => {
    assert.equal(laneSecretsKey("lane-7"), "lane:lane-7");
  });
});

describe("the launch panel", () => {
  it("draws the reason instead of a form Cursor could never accept", () => {
    const panel = buildLaunchPanel({ unavailable: "This repo is not connected to Cursor." });
    assert.equal(panel.body[0].component, "emptyState");
    assert.ok(!JSON.stringify(panel.body).includes('"form"'));
  });

  it("puts a toggle per remembered secret, and never a value", () => {
    const panel = buildLaunchPanel({
      lanes: [{ id: "lane-1", name: "One" }],
      secretNames: ["DATABASE_URL"],
      selectedSecrets: ["DATABASE_URL"],
    });
    const form = panel.body.find((node) => node.component === "form");
    const secret = form.fields.find((field) => field.id === "secret:DATABASE_URL");
    assert.equal(secret.kind, "toggle");
    assert.equal(secret.value, true);
    assert.ok(!JSON.stringify(panel).includes("postgres"), "a value never enters a panel schema");
    const secretsButton = panel.body.find((node) => node.label === "Manage project secrets");
    assert.equal(secretsButton?.onPress?.action, "openSecretsSettings");
  });

  it("stays inside the form's field ceiling", () => {
    const panel = buildLaunchPanel({
      lanes: [{ id: "lane-1", name: "One" }],
      models: ["a", "b"],
      reasoningOptions: [{ value: "high", label: "High" }],
      showSpeed: true,
      secretNames: Array.from({ length: 40 }, (_, i) => `S${i}`),
    });
    const form = panel.body.find((node) => node.component === "form");
    assert.ok(form.fields.length <= 24, "maxFormFields is 24");
    assert.ok(form.fields.some((field) => field.id === "reasoningEffort"));
    assert.ok(form.fields.some((field) => field.id === "fastMode"));
  });
});

describe("the fleet filter row", () => {
  it("compares row fields against panel state, never against an expression", () => {
    assert.deepEqual(fleetWhere(), [
      { field: "status", in: { $state: "status" } },
      { field: "laneId", in: { $state: "lane" } },
      { field: "archivedFlag", in: { $state: "archived" } },
    ]);
    // Four is the ceiling on one binding's `where`.
    assert.ok(fleetWhere().length <= 4);
  });

  it("spells All as the empty value, which turns its clause off", () => {
    const row = fleetFilterRow({ counts: { active: 2, archived: 3 }, laneOptions: [{ id: "lane-1", name: "One" }] });
    const status = row.children.find((node) => node.stateKey === "status");
    assert.equal(status.options[0].value, "");
    assert.equal(status.options[0].label, "All");
    assert.equal(status.default, "");

    // "Show archived" means AS WELL AS, so its value is the unset one — an
    // option spelled "show" would have filtered the live rows away instead.
    const archived = row.children.find((node) => node.stateKey === "archived");
    assert.equal(archived.options[0].value, "hide");
    assert.equal(archived.options[1].value, "");
    assert.equal(archived.style, "toggle");
  });

  it("omits the archived control when there is nothing archived to show", () => {
    const row = fleetFilterRow({ counts: { active: 0, archived: 0 } });
    assert.equal(row.children.some((node) => node.stateKey === "archived"), false);
  });

  it("declares no more state keys than a panel may hold", () => {
    const row = fleetFilterRow({ counts: { active: 1, archived: 1 }, laneOptions: [{ id: "l", name: "L" }] });
    assert.ok(row.children.length <= 4, "maxStateKeys is 4");
    for (const node of row.children) {
      assert.ok(node.options.length >= 2, "a control with one option is not a control");
      assert.ok(node.options.length <= 8, "maxStateOptions is 8");
    }
  });
});

describe("the fleet panel's five states", () => {
  it("points at Settings rather than showing an empty list with no key", () => {
    const panel = buildFleetPanel({ state: "no-key" });
    assert.match(JSON.stringify(panel.body), /Agents → Cursor/);
    assert.ok(JSON.stringify(panel.body).includes("openCursorSettings"));
    assert.ok(!JSON.stringify(panel.body).includes('"list"'));
  });

  it("draws the Automations strip from the host ledger, including a copyable URL", () => {
    const panel = buildFleetPanel({
      state: "empty",
      counts: { active: 0, lanes: 0, unlinked: 0, total: 0, archived: 0 },
      webhook: {
        status: "Endpoint ready",
        tone: "neutral",
        lastEvent: "2026-09-02 07:00 UTC",
        pendingDeliveries: 0,
        drainError: null,
        url: "https://relay.example/plugin/ade-cursor-cloud/webhook",
      },
    });
    const json = JSON.stringify(panel.body);
    assert.match(json, /Automations/);
    assert.match(json, /Endpoint ready/);
    assert.match(json, /2026-09-02 07:00 UTC/);
    assert.ok(json.includes("copyWebhookUrl"));
    assert.ok(json.includes("https://relay.example/plugin/ade-cursor-cloud/webhook"));
  });

  it("offers a retry on an error", () => {
    const panel = buildFleetPanel({ state: "error", error: "Cursor is rate limiting this key" });
    assert.match(panel.body[0].description, /rate limiting/);
    assert.equal(panel.body[0].action.onPress.action, "refreshFleet");
  });

  it("offers the launch form from the empty state", () => {
    const panel = buildFleetPanel({ state: "empty", counts: { active: 0, lanes: 0, unlinked: 0, total: 0, archived: 0 } });
    assert.equal(panel.body[0].action.onPress.action, "openLaunch");
  });

  it("carries a deeplink fallback on every state, for a client that cannot draw it", () => {
    for (const state of ["loading", "no-key", "error", "empty", "list"]) {
      const panel = buildFleetPanel({ state });
      assert.equal(panel.fallback.deeplink, "ade://plugin/ade-cursor-cloud/fleet", state);
      assert.ok(panel.fallback.text.length > 0, state);
    }
  });

  it("allows a bound row exactly the actions the panel declared", () => {
    const panel = buildFleetPanel({ state: "list", counts: { active: 1, lanes: 0, unlinked: 0, total: 1, archived: 0 } });
    const lists = panel.body.filter((node) => node.component === "list");
    assert.equal(lists.length, 3);
    for (const list of lists) {
      assert.ok(list.bind.allowActions.length <= 16, "maxBindingAllowActions is 16");
      assert.ok(!list.bind.allowActions.includes("createRun"), "a row may not launch a new agent");
      assert.deepEqual(list.bind.where, fleetWhere());
    }
  });
});

describe("the create-time fields the compiled composer always sent", () => {
  it("sends startingRef, an attached PR, and the two branch flags", () => {
    const request = buildCreateRequest({
      prompt: "fix it",
      repoUrl: "https://github.com/acme/app",
      startingRef: "ade/fix",
      prUrl: "https://github.com/acme/app/pull/7",
      workOnCurrentBranch: true,
      skipReviewerRequest: true,
    });
    assert.deepEqual(request, {
      prompt: { text: "fix it" },
      repos: [{ url: "https://github.com/acme/app", startingRef: "ade/fix" }],
      prUrl: "https://github.com/acme/app/pull/7",
      workOnCurrentBranch: true,
      skipReviewerRequest: true,
    });
  });

  it("keeps `branch` working as the older caller's word for startingRef", () => {
    const request = buildCreateRequest({ prompt: "go", repoUrl: "u", branch: "ade/x" });
    assert.equal(request.repos[0].startingRef, "ade/x");
  });
});

describe("the PR fields, which are creation-time only", () => {
  it("attaches to a PR the branch already has instead of asking for a second", () => {
    assert.deepEqual(
      resolvePrCreateFields({ existingPrUrl: " https://github.com/acme/app/pull/7 ", autoCreatePR: true }),
      { autoCreatePR: false, prUrl: "https://github.com/acme/app/pull/7" },
    );
  });

  it("omits prUrl entirely rather than sending it null", () => {
    const fields = resolvePrCreateFields({ autoCreatePR: true });
    assert.deepEqual(fields, { autoCreatePR: true });
    assert.equal("prUrl" in fields, false);
    assert.deepEqual(resolvePrCreateFields({}), { autoCreatePR: false });
  });
});

describe("the launch ladder, in the composer's own order", () => {
  const ready = {
    repoProbe: "ready",
    laneId: "lane-1",
    remoteProbe: "ready",
    laneRemote: "git@github.com:acme/app.git",
    repoConnected: true,
  };

  it("names the thing that is actually true right now", () => {
    assert.equal(launchUnavailableReason({ repoProbe: "loading" }), "Checking Cursor Cloud…");
    assert.equal(
      launchUnavailableReason({ repoProbe: "error", repoProbeMessage: "Cursor is rate limiting this key" }),
      "Cursor is rate limiting this key",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, laneId: null }),
      "Choose a lane before sending to Cursor Cloud.",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, remoteProbe: "loading" }),
      "Checking this lane's git remote…",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, remoteProbe: "error", remoteError: "not a git repository" }),
      "Could not read this lane's git remote: not a git repository",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, remoteProbe: "error" }),
      "Could not read this lane's git remote: The git remote read failed.",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, laneRemote: null }),
      "This lane has no GitHub remote, so there is nothing for Cursor Cloud to clone.",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, repoConnected: false }),
      "This repo is not connected to Cursor. Connect it in Cursor, then try again.",
    );
    assert.equal(launchUnavailableReason(ready), null);
  });

  it("never blames a missing remote for a probe that is still in flight", () => {
    // The whole reason the probes are tri-state: a pending read reported as
    // "not connected" is a sentence the reader cannot act on.
    assert.equal(launchUnavailableReason({ repoProbe: "loading", laneRemote: null }), "Checking Cursor Cloud…");
    assert.equal(
      launchUnavailableReason({ ...ready, remoteProbe: "loading", laneRemote: null }),
      "Checking this lane's git remote…",
    );
  });

  it("checks the model only for a caller that is about to send", () => {
    assert.equal(launchUnavailableReason({ ...ready, catalogModelIds: ["composer-2"] }), null);
    assert.equal(
      launchUnavailableReason({ ...ready, checkModel: true, catalogModelIds: ["composer-2"], modelId: "gpt-9" }),
      "Choose a Cursor Cloud model first",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, checkModel: true, catalogModelIds: [], modelId: "composer-2" }),
      "Cursor's model list has not loaded yet. Open the model picker to load it, then try again.",
    );
    assert.equal(
      launchUnavailableReason({ ...ready, checkModel: true, catalogModelIds: ["composer-2"], modelId: "composer-2" }),
      null,
    );
  });
});

describe("preparing origin before Cursor clones it", () => {
  function fakeGit(sync, options = {}) {
    const pushes = [];
    return {
      pushes,
      getSyncStatus: async () => {
        if (options.syncThrows) throw options.syncThrows;
        return sync;
      },
      push: async (args) => {
        pushes.push(args);
        if (options.pushThrows) throw options.pushThrows;
      },
    };
  }

  it("blocks a diverged branch rather than force-pushing over origin", async () => {
    const git = fakeGit({ hasUpstream: true, diverged: true, ahead: 2, behind: 3, upstreamRef: "origin/ade/x" });
    await assert.rejects(
      ensureExistingLaneOriginReady({ laneId: "lane-1", git }),
      /behind origin and also has local commits/,
    );
    assert.deepEqual(git.pushes, []);
  });

  it("blocks an ahead-and-behind branch even when git did not call it diverged", async () => {
    const git = fakeGit({ hasUpstream: true, diverged: false, ahead: 1, behind: 1 });
    await assert.rejects(ensureExistingLaneOriginReady({ laneId: "lane-1", git }), /Pull or rebase/);
  });

  it("skips the push when origin is simply newer", async () => {
    // Origin is what the cloud clones, and it already has everything.
    const git = fakeGit({ hasUpstream: true, diverged: false, ahead: 0, behind: 4 });
    assert.deepEqual(await ensureExistingLaneOriginReady({ laneId: "lane-1", git }), { pushed: false });
    assert.deepEqual(git.pushes, []);
  });

  it("pushes a branch with no upstream, and one with local commits", async () => {
    const fresh = fakeGit({ hasUpstream: false, ahead: 0, behind: 0 });
    assert.deepEqual(await ensureExistingLaneOriginReady({ laneId: "lane-1", git: fresh }), { pushed: true });
    assert.deepEqual(fresh.pushes, [{ laneId: "lane-1" }]);

    const ahead = fakeGit({ hasUpstream: true, diverged: false, ahead: 2, behind: 0 });
    await ensureExistingLaneOriginReady({ laneId: "lane-1", git: ahead });
    assert.deepEqual(ahead.pushes, [{ laneId: "lane-1" }]);
  });

  it("pushes rather than assuming the worst when the sync read fails", async () => {
    const git = fakeGit(null, { syncThrows: new Error("no upstream configured") });
    await ensureExistingLaneOriginReady({ laneId: "lane-1", git });
    assert.deepEqual(git.pushes, [{ laneId: "lane-1" }]);
  });

  it("rewrites git's stderr into a sentence with an action in it", async () => {
    const rejected = fakeGit({ hasUpstream: false }, {
      pushThrows: new Error("! [rejected] ade/x -> ade/x (fetch first)\nhint: Updates were rejected"),
    });
    await assert.rejects(
      ensureExistingLaneOriginReady({ laneId: "lane-1", branchHint: "ade/x", git: rejected }),
      /^Error: Branch ade\/x is behind origin, so ADE could not push it\. Pull or rebase in the lane, then send again\.$/,
    );

    const denied = fakeGit({ hasUpstream: false }, { pushThrows: new Error("Permission denied (publickey).") });
    await assert.rejects(
      ensureExistingLaneOriginReady({ laneId: "lane-1", git: denied }),
      /GitHub refused the push\. Check your access, then send again\.$/,
    );

    const other = fakeGit({ hasUpstream: false }, { pushThrows: new Error("\n  the remote hung up  \nsecond line") });
    await assert.rejects(
      ensureExistingLaneOriginReady({ laneId: "lane-1", git: other }),
      /ADE could not push this lane's branch to origin: the remote hung up$/,
    );
  });
});

describe("the idempotency memo", () => {
  it("gives one key per draft, so a retry adopts instead of duplicating", () => {
    const first = idempotencyKeyFor("fix the sync test", "https://github.com/acme/app");
    assert.equal(idempotencyKeyFor("fix the sync test", "https://github.com/acme/app"), first);
    // A different prompt, or the same prompt against a different repo, is a
    // different launch and must not adopt this agent.
    assert.notEqual(idempotencyKeyFor("fix the lint", "https://github.com/acme/app"), first);
    assert.notEqual(idempotencyKeyFor("fix the sync test", "https://github.com/acme/other"), first);
  });

  it("keeps the key after a failure and drops it after a success", () => {
    const key = idempotencyKeyFor("ship it", "https://github.com/acme/app");
    // A failure changes nothing: the next attempt reuses the key and Cursor
    // answers with the agent it already made.
    assert.equal(idempotencyKeyFor("ship it", "https://github.com/acme/app"), key);
    clearIdempotencyKey("ship it", "https://github.com/acme/app");
    assert.notEqual(idempotencyKeyFor("ship it", "https://github.com/acme/app"), key);
  });
});
