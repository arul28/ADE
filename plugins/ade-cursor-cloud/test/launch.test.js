"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  agentNameFromPrompt,
  buildCreateRequest,
  collectSecretValues,
  findConnectedRepo,
  isInjectableSecretName,
  laneSecretsKey,
  readLaunchForm,
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
