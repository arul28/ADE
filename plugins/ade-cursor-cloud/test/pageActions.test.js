// The page tier's action table, against the real shaping helpers and a fake Cursor.
//
// These handlers are the only thing between an ordinary web page and the
// machine's Cursor API key, so the cases here are written around the three
// failures that would matter most:
//
//   * a read that answers a shape the page cannot draw — a missing field is a
//     blank column, and `page/src/types.ts` is the contract that says which;
//   * a mutation that THROWS where the page expected `{ok, message}` — a
//     rejected promise beside a filled-in form is the wrong shape for a form;
//   * a result carrying the API key. The webview bridge exposes no `secrets`
//     verb on purpose, and a key that leaked through a data field would undo
//     that with nothing anywhere reporting it. The last case in this file walks
//     every handler's result and fails on one.
//
// `format.js`, `fleet.js` and `launch.js` are the REAL modules here rather than
// stubs: what these handlers are is a mapping onto those, and a test that
// stubbed them would pass while the mapping was wrong.

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createPageActions, pageRun, decorate } = require("../pageActions");
const { findConnectedRepo } = require("../launch");
const { catalogControlOptions, readCatalog } = require("../modelSelection");
const { groupFleet } = require("../fleet");
const { fleetFooter } = require("../panels");

/** The key the fake credential holds, so the sweep has a needle. */
const FAKE_KEY = "key_cursor_abcdef0123456789";

const REPO = "https://github.com/acme/app";

function fleetEntry(overrides = {}) {
  const agent = {
    agentId: "bc_abc123",
    name: "Fix the flaky sync test",
    summary: "Fix the flaky sync test and open a PR.",
    archived: false,
    status: "running",
    createdAt: Date.parse("2026-09-02T10:00:00.000Z"),
    lastModified: Date.now() - 60_000,
    repos: [REPO],
    webUrl: "https://cursor.com/agents?id=bc_abc123",
    latestRunId: "run_1",
    ...(overrides.agent ?? {}),
  };
  return {
    agent,
    runStatus: "running",
    latestRunId: "run_1",
    branch: "cursor/fix-sync",
    prUrl: null,
    modelId: "composer-2",
    matchedBy: "repo",
    ownership: {
      sessionId: null,
      sessionTitle: null,
      laneId: "lane-1",
      laneName: "sync-fix",
      linearIssueId: null,
    },
    ...overrides,
    agent,
  };
}

/**
 * Everything `index.js` hands the page table, faked.
 *
 * `options` moves one thing at a time so a case reads as the one condition it
 * is about — no key, a refused list, an agent that is not in the fleet.
 */
function makeDeps(options = {}) {
  const items = options.items ?? [fleetEntry()];
  const collections = new Map(Object.entries(options.collections ?? {}));
  const invoked = [];
  const created = [];
  const clipboard = [];
  const launches = [];

  const api = {
    hasKey: async () => options.hasKey !== false,
    getMe: async () => {
      if (options.meThrows) throw options.meThrows;
      return { apiKeyName: "ade", userEmail: "ada@example.com", createdAt: "2026-01-01T00:00:00.000Z" };
    },
    listRepositories: async () => {
      if (options.reposThrows) throw options.reposThrows;
      return { items: [{ url: REPO }] };
    },
    listModels: async () => ({
      items: [
        {
          id: "composer-2",
          parameters: [
            { id: "reasoning_effort", values: [{ value: "high", displayName: "High" }] },
            { id: "service_tier", values: [{ value: "fast" }, { value: "standard" }] },
          ],
        },
        { id: "sonnet-4.5" },
      ],
    }),
    getAgentUsage: async () => ({
      totalUsage: { totalTokens: 128_000, inputTokens: 96_000, outputTokens: 32_000 },
      cost: { chargedCents: 120 },
    }),
    listRuns: async (agentId, params) => {
      invoked.push({ kind: "listRuns", agentId, params });
      return {
        items: [{
          id: "run_1",
          status: "RUNNING",
          model: { id: "composer-2" },
          createdAt: "2026-09-02T10:00:00.000Z",
          git: { branches: [{ branch: "cursor/fix-sync", prUrl: null }] },
        }],
      };
    },
    listArtifacts: async () => ({ items: [{ path: "/reports/coverage.json", sizeBytes: 4096 }] }),
    getArtifactDownloadUrl: async () => {
      if (options.downloadThrows) throw options.downloadThrows;
      return { url: options.downloadUrl ?? "https://files.cursor.com/a.json" };
    },
    createRun: async (agentId, body) => {
      created.push({ agentId, body });
      if (options.followUpThrows) throw options.followUpThrows;
      return { run: { id: "run_2" } };
    },
  };

  const sdk = {
    collections: {
      get: async (collection, key) => collections.get(`${collection}/${key}`) ?? null,
      put: async (collection, key, value) => { collections.set(`${collection}/${key}`, value); },
      list: async () => [],
      delete: async () => {},
    },
    config: { get: async () => ({ autoOpenPr: options.autoOpenPr === true }) },
    // The key exists on the SDK, exactly as it does in the child, so a handler
    // that reached for it would have something to leak.
    secrets: { get: async () => null, getProviderKey: async () => FAKE_KEY },
    clipboard: { write: async (value) => { clipboard.push(value); } },
    actions: {
      invoke: async (domain, action, args) => {
        invoked.push({ domain, action, args });
        if (domain === "git" && action === "getOpenPrForBranch") {
          return options.openPr ?? { prUrl: null, prNumber: null, title: null };
        }
        if (domain === "lane" && action === "createChild") {
          invoked.push({ kind: "createChild", args });
          return { id: "lane-new", name: args?.name ?? "cloud-agent" };
        }
        return null;
      },
    },
  };

  const deps = {
    sdk,
    api,
    runtime: {
      openAgent: async ({ agentId, laneId }) => {
        invoked.push({ kind: "openAgent", agentId, laneId });
        if (options.openAgentThrows) throw options.openAgentThrows;
        return { sessionId: "session-1", created: true };
      },
    },
    links: { get: async () => options.link ?? null, set: async () => {}, list: async () => [] },
    log: () => {},
    listLanes: async () => options.lanes ?? [
      { id: "lane-1", name: "sync-fix", branchRef: "ade/sync-fix" },
      { id: "lane-2", name: "docs", branchRef: "ade/docs" },
    ],
    readLaneRemote: async (laneId) => {
      if (options.remoteThrows) throw options.remoteThrows;
      const remoteUrl = "laneRemote" in options ? options.laneRemote : "git@github.com:acme/app.git";
      return { remoteUrl, branch: `ade/${laneId}` };
    },
    findConnectedRepo,
    readCatalog,
    catalogControlOptions,
    groupFleet,
    fleetFooter,
    refreshFleet: async () => options.fleetResult ?? { state: items.length ? "list" : "empty" },
    readWebhookSnapshot: async () => options.webhook ?? {
      status: "Endpoint ready",
      tone: "neutral",
      state: "ready",
      lastEvent: "2026-09-03 09:58 UTC",
      pendingDeliveries: 0,
      drainError: null,
      url: "https://relay.ade.dev/plugin/ade-cursor-cloud/webhook/cursor",
    },
    findEntry: async (agentId) => items.find((entry) => entry.agent.agentId === agentId) ?? null,
    runLaunch: async (form) => {
      launches.push(form);
      return options.launchResult
        ?? { ok: true, message: "Launched on Cursor Cloud.", agentId: "bc_new1", sessionId: "session-1", laneId: "lane-1" };
    },
    fleetSnapshot: () => ({
      at: Date.parse("2026-09-03T10:00:00.000Z"),
      items,
      archivedCount: items.filter((entry) => entry.agent.archived).length,
      lanes: [{ id: "lane-1", name: "sync-fix" }],
    }),
    ackTabBadge: async (args) => { invoked.push({ kind: "ackTabBadge", args }); },
    invokeOwnAction: async (id, args) => {
      invoked.push({ kind: "own", id, args });
      return options.ownResult ?? { ok: true, message: "Stopped." };
    },
  };

  return { actions: createPageActions(deps), invoked, created, clipboard, launches, collections, items };
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

describe("pageFleet answers the CloudFleetPage the types declare", () => {
  it("carries every field in every state, so a page never branches on undefined", async () => {
    const { actions } = makeDeps();
    const page = await actions.pageFleet();

    assert.deepEqual(Object.keys(page).sort(), [
      "archivedCount", "counts", "entries", "error", "fetchedAt", "footer", "groups", "laneOptions", "state", "webhook",
    ]);
    assert.equal(page.state, "list");
    assert.equal(page.error, null);
    assert.deepEqual(Object.keys(page.groups).sort(), ["active", "lanes", "unlinked"]);
    assert.equal(page.counts.total, 1);
    assert.equal(page.webhook.state, "ready");
  });

  it("pre-formats age, status and active so the page does no date maths", async () => {
    const { actions } = makeDeps();
    const [entry] = (await actions.pageFleet()).entries;
    assert.equal(entry.age, "1m");
    assert.equal(entry.status, "running");
    assert.equal(entry.active, true);
    assert.match((await actions.pageFleet()).footer, /^1 agent · updated just now$/);
  });

  it("says no-key rather than drawing an empty list over a missing key", async () => {
    const { actions } = makeDeps({ hasKey: false, fleetResult: { state: "no-key" } });
    const page = await actions.pageFleet();
    assert.equal(page.state, "no-key");
    assert.deepEqual(page.entries, []);
    assert.deepEqual(page.groups, { active: [], lanes: [], unlinked: [] });
    // The relay strip is still drawn: the webhook does not depend on the key.
    assert.equal(page.webhook.state, "ready");
  });

  it("carries a refusal in `error` rather than rejecting the page", async () => {
    const { actions } = makeDeps({ fleetResult: { state: "error", error: "Cursor is rate limiting this key" } });
    const page = await actions.pageFleet();
    assert.equal(page.state, "error");
    assert.match(page.error, /rate limiting/);
  });

  it("hides an archived agent from the list and still counts it", async () => {
    const archived = fleetEntry({ agent: { agentId: "bc_old", archived: true, status: undefined } });
    const { actions } = makeDeps({ items: [fleetEntry(), archived] });
    const page = await actions.pageFleet();
    assert.equal(page.entries.length, 1);
    assert.equal(page.counts.archived, 1);
    assert.equal(page.archivedCount, 1);
  });
});

describe("pageAgent answers the CloudAgentPage the types declare", () => {
  it("returns the entry, the usage, the runs and a signed artifact URL", async () => {
    const { actions, invoked } = makeDeps();
    const page = await actions.pageAgent({ agentId: "bc_abc123" });

    assert.deepEqual(Object.keys(page).sort(), ["artifacts", "entry", "error", "runs", "sessionId", "usage"]);
    assert.equal(page.entry.agent.agentId, "bc_abc123");
    assert.equal(page.entry.status, "running");
    assert.equal(page.usage.cost, "$1.20");
    assert.equal(page.usage.inputTokens, 96_000);
    assert.equal(page.runs[0].runId, "run_1");
    assert.equal(page.runs[0].status, "running");
    assert.equal(page.runs[0].branch, "cursor/fix-sync");
    // The leading slash is stripped: the page renders it as a relative path.
    assert.deepEqual(page.artifacts, [
      { path: "reports/coverage.json", bytes: 4096, url: "https://files.cursor.com/a.json" },
    ]);
    // Never a page bigger than Cursor's ceiling.
    const runsCall = invoked.find((call) => call.kind === "listRuns");
    assert.ok(runsCall.params.limit <= 100, "Cursor refuses limit above 100");
  });

  it("lists the artifact with no URL when the mint fails", async () => {
    const { actions } = makeDeps({ downloadThrows: new Error("no artifact scope") });
    const page = await actions.pageAgent({ agentId: "bc_abc123" });
    assert.deepEqual(page.artifacts, [{ path: "reports/coverage.json", bytes: 4096, url: null }]);
  });

  it("refuses a URL that is not HTTPS, because the page hands it to a browser", async () => {
    const { actions } = makeDeps({ downloadUrl: "file:///etc/passwd" });
    const page = await actions.pageAgent({ agentId: "bc_abc123" });
    assert.equal(page.artifacts[0].url, null);
  });

  it("answers a drawable not-found state rather than throwing", async () => {
    const { actions } = makeDeps();
    const page = await actions.pageAgent({ agentId: "bc_missing" });
    assert.equal(page.entry, null);
    assert.equal(page.error, "It is not in this project's fleet.");
    assert.deepEqual(page.runs, []);
    assert.deepEqual(page.artifacts, []);
  });
});

describe("pageLaunchContext runs the same ladder Enter runs", () => {
  it("draws the form for a lane whose repo Cursor is connected to", async () => {
    const { actions } = makeDeps();
    const context = await actions.pageLaunchContext({ laneId: "lane-1", draft: "fix it" });

    assert.equal(context.unavailable, null);
    assert.equal(context.repoUrl, REPO);
    assert.equal(context.repoLabel, "acme/app");
    assert.equal(context.repoCaption, "Cursor clones acme/app and pushes back to it.");
    assert.equal(context.laneId, "lane-1");
    assert.equal(context.branch, "ade/lane-1");
    assert.equal(context.draft, "fix it");
    assert.equal(context.showSpeed, true);
    assert.deepEqual(context.reasoningOptions, [{ value: "high", label: "High" }]);
    // Per-model, not per-catalog: `sonnet-4.5` names no parameters at all.
    assert.deepEqual(context.models.map((model) => model.id), ["composer-2", "sonnet-4.5"]);
    assert.equal(context.models[0].speed, true);
    assert.deepEqual(context.models[1].reasoningEfforts, []);
    assert.equal(context.models[1].speed, false);
  });

  it("names the reason in the composer's own words, in the composer's own order", async () => {
    const noKey = await makeDeps({ hasKey: false }).actions.pageLaunchContext({});
    assert.equal(noKey.unavailable, "Add a Cursor API key in Settings → AI connections, then try again.");

    const probeError = await makeDeps({ reposThrows: new Error("Cursor is rate limiting this key") })
      .actions.pageLaunchContext({ laneId: "lane-1" });
    assert.equal(probeError.unavailable, "Cursor is rate limiting this key");

    const noLane = await makeDeps({ lanes: [] }).actions.pageLaunchContext({});
    assert.equal(noLane.unavailable, "Choose a lane before sending to Cursor Cloud.");

    const remoteError = await makeDeps({ remoteThrows: new Error("not a git repository") })
      .actions.pageLaunchContext({ laneId: "lane-1" });
    assert.equal(remoteError.unavailable, "Could not read this lane's git remote: not a git repository");

    const noRemote = await makeDeps({ laneRemote: null }).actions.pageLaunchContext({ laneId: "lane-1" });
    assert.equal(
      noRemote.unavailable,
      "This lane has no GitHub remote, so there is nothing for Cursor Cloud to clone.",
    );

    const unconnected = await makeDeps({ laneRemote: "git@github.com:acme/secret.git" })
      .actions.pageLaunchContext({ laneId: "lane-1" });
    assert.equal(
      unconnected.unavailable,
      "This repo is not connected to Cursor. Connect it in Cursor, then try again.",
    );
  });

  it("never asks the form to pick a model before the form is drawn", async () => {
    // The composer's model rungs are Enter's, not the form's: a form that
    // refused to draw because no model was picked could never be used.
    const { actions } = makeDeps();
    const context = await actions.pageLaunchContext({ laneId: "lane-1" });
    assert.equal(context.unavailable, null);
    assert.ok(context.models.length > 0);
  });

  it("offers remembered secret NAMES and the lane's open PR", async () => {
    const { actions } = makeDeps({
      collections: { "laneSecrets/lane:lane-1": { names: ["DATABASE_URL", "CURSOR_API_KEY"] } },
      openPr: { prUrl: "https://github.com/acme/app/pull/7", prNumber: 7, title: "Fix sync" },
    });
    const context = await actions.pageLaunchContext({ laneId: "lane-1" });
    // Cursor's own namespace is refused here as everywhere else.
    assert.deepEqual(context.secretNames, ["DATABASE_URL"]);
    assert.deepEqual(context.selectedSecrets, ["DATABASE_URL"]);
    assert.equal(context.rememberSecretNames, true);
    assert.deepEqual(context.existingPr, {
      prUrl: "https://github.com/acme/app/pull/7",
      prNumber: 7,
      title: "Fix sync",
    });
  });
});

describe("pageConnection", () => {
  it("answers whose key it is, and only that", async () => {
    const { actions } = makeDeps();
    const connection = await actions.pageConnection();
    assert.deepEqual(connection, {
      hasKey: true,
      apiKeyName: "ade",
      userEmail: "ada@example.com",
      message: null,
    });
  });

  it("points at Settings when there is no key", async () => {
    const { actions } = makeDeps({ hasKey: false });
    const connection = await actions.pageConnection();
    assert.equal(connection.hasKey, false);
    assert.equal(connection.message, "Connect a Cursor API key in Settings → AI connections.");
  });

  it("keeps hasKey true when Cursor refuses to describe a key that exists", async () => {
    // Saying "no key" here would send the reader to Settings to fix something
    // that is not wrong.
    const { actions } = makeDeps({ meThrows: new Error("Cursor is rate limiting this key") });
    const connection = await actions.pageConnection();
    assert.equal(connection.hasKey, true);
    assert.match(connection.message, /rate limiting/);
  });
});

/* ── Mutations ───────────────────────────────────────────────────────────── */

describe("every mutation answers {ok, message} and never throws", () => {
  it("routes the launch through the one launch path", async () => {
    const { actions, launches } = makeDeps();
    const result = await actions.pageLaunch({
      prompt: "fix it",
      laneId: "lane-1",
      model: "composer-2",
      openPr: true,
      secretNames: ["DATABASE_URL"],
      rememberSecretNames: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.agentId, "bc_new1");
    assert.equal(result.sessionId, "session-1");
    assert.deepEqual(launches[0].secretNames, ["DATABASE_URL"]);
    assert.equal(launches[0].openPr, true);
  });

  it("answers a refused launch as a sentence, not a rejection", async () => {
    const { actions } = makeDeps({
      launchResult: { ok: false, message: "This repo is not connected to Cursor. Connect it in Cursor, then try again." },
    });
    const result = await actions.pageLaunch({ prompt: "fix it" });
    assert.equal(result.ok, false);
    assert.match(result.message, /not connected to Cursor/);
  });

  it("adopts an agent as a chat and names the chat it became", async () => {
    const { actions } = makeDeps();
    const result = await actions.pageOpenInAde({ agentId: "bc_abc123" });
    assert.deepEqual(result, {
      ok: true,
      message: "Opened this cloud agent as a chat in ADE.",
      sessionId: "session-1",
    });
  });

  it("opens in the local lane that already has the agent's branch", async () => {
    const laneless = fleetEntry({
      branch: "ade/sync-fix",
      ownership: { sessionId: null, sessionTitle: null, laneId: null, laneName: null, linearIssueId: null },
    });
    const { actions, invoked } = makeDeps({ items: [laneless] });
    const result = await actions.pageOpenInAde({ agentId: "bc_abc123" });
    assert.equal(result.ok, true);
    assert.equal(invoked.find((call) => call.kind === "openAgent")?.laneId, "lane-1");
  });

  it("asks to create a lane when no local lane has the branch", async () => {
    const laneless = fleetEntry({
      ownership: { sessionId: null, sessionTitle: null, laneId: null, laneName: null, linearIssueId: null },
    });
    const { actions } = makeDeps({ items: [laneless] });
    const result = await actions.pageOpenInAde({ agentId: "bc_abc123" });
    assert.equal(result.ok, false);
    assert.equal(result.needsLane, true);
    assert.match(result.message, /no local lane yet/);
  });

  it("creates a lane from primary when the page confirms", async () => {
    const laneless = fleetEntry({
      branch: "ade/cloud-run",
      ownership: { sessionId: null, sessionTitle: null, laneId: null, laneName: null, linearIssueId: null },
    });
    const { actions, invoked } = makeDeps({
      items: [laneless],
      lanes: [{ id: "lane-primary", name: "main", laneType: "primary", branchRef: "main" }],
    });
    const result = await actions.pageOpenInAde({ agentId: "bc_abc123", createLane: true });
    assert.equal(result.ok, true);
    assert.equal(invoked.find((call) => call.kind === "openAgent")?.laneId, "lane-new");
  });

  it("answers a chat binding Cursor accepted but ADE refused", async () => {
    const { actions } = makeDeps({ openAgentThrows: new Error("that lane is gone") });
    const result = await actions.pageOpenInAde({ agentId: "bc_abc123" });
    assert.deepEqual(result, { ok: false, message: "that lane is gone" });
  });

  it("sends a follow-up as a new run on the agent that already exists", async () => {
    const { actions, created } = makeDeps();
    const result = await actions.pageFollowUp({ agentId: "bc_abc123", prompt: "  also fix the lint  " });
    assert.deepEqual(result, { ok: true, message: "Sent to Cursor Cloud.", runId: "run_2" });
    assert.deepEqual(created[0], { agentId: "bc_abc123", body: { prompt: { text: "also fix the lint" } } });
  });

  it("answers a follow-up Cursor refused rather than throwing at the page", async () => {
    const { actions } = makeDeps({ followUpThrows: new Error("That agent has already finished") });
    const result = await actions.pageFollowUp({ agentId: "bc_abc123", prompt: "more" });
    assert.deepEqual(result, { ok: false, message: "That agent has already finished" });
  });

  it("asks for an agent id rather than acting on nothing", async () => {
    const { actions } = makeDeps();
    for (const id of ["pageStopRun", "pagePullIntoLane", "pageArchiveAgent", "pageUnarchiveAgent", "pageDeleteAgent", "pageFollowUp"]) {
      const result = await actions[id]({});
      assert.equal(result.ok, false, id);
      assert.match(result.message, /agent id/, id);
    }
  });

  it("runs the plugin's own handler rather than a second copy of it", async () => {
    // Two code paths for one act is how they drift. The page invokes the SAME
    // handler a panel row presses and drops what a page cannot draw.
    const { actions, invoked } = makeDeps();
    await actions.pageStopRun({ agentId: "bc_abc123" });
    await actions.pagePullIntoLane({ agentId: "bc_abc123" });
    await actions.pageArchiveAgent({ agentId: "bc_abc123" });
    await actions.pageUnarchiveAgent({ agentId: "bc_abc123" });
    await actions.pageDeleteAgent({ agentId: "bc_abc123" });
    await actions.pageCopyWebhookUrl();
    assert.deepEqual(
      invoked.filter((call) => call.kind === "own").map((call) => call.id),
      ["stopRun", "pullIntoLane", "archiveAgent", "unarchiveAgent", "deleteAgent", "copyWebhookUrl"],
    );
  });

  it("drops the panel vocabulary a page cannot draw", async () => {
    const { actions } = makeDeps({ ownResult: { message: "Archived.", resetState: ["status"] } });
    const result = await actions.pageArchiveAgent({ agentId: "bc_abc123" });
    assert.deepEqual(result, { ok: true, message: "Archived." });
  });

  it("acknowledges the badge with nothing to draw", async () => {
    const { actions, invoked } = makeDeps();
    assert.equal(await actions.pageAckBadge({}), null);
    assert.deepEqual(invoked.find((call) => call.kind === "ackTabBadge").args, { viewed: true });
    await actions.pageAckBadge({ viewed: false });
    assert.deepEqual(invoked.filter((call) => call.kind === "ackTabBadge").at(-1).args, { viewed: false });
  });
});

describe("a page opened before activate finished", () => {
  it("answers its own empty shape rather than 'no such action'", async () => {
    const actions = createPageActions({
      get sdk() { return null; },
      get api() { return null; },
      get runtime() { return null; },
    });
    assert.equal((await actions.pageFleet()).state, "loading");
    assert.equal((await actions.pageAgent({ agentId: "x" })).entry, null);
    assert.match((await actions.pageLaunchContext({})).unavailable, /still starting up/);
    assert.equal((await actions.pageConnection()).hasKey, false);
    assert.equal((await actions.pageLaunch({ prompt: "x" })).ok, false);
    assert.equal(await actions.pageAckBadge({}), null);
  });
});

/* ── Shaping ─────────────────────────────────────────────────────────────── */

describe("the shaping helpers", () => {
  it("answers null for a run row with no id", () => {
    assert.equal(pageRun({}, Date.now()), null);
    assert.equal(pageRun(null, Date.now()), null);
  });

  it("maps an unknown run status to null rather than a raw string", () => {
    // The page colours on this field, and an unmapped word would draw as the
    // fallback tone with no way to tell it was never understood.
    assert.equal(pageRun({ id: "r", status: "PROVISIONING" }, Date.now()).status, null);
    assert.equal(pageRun({ id: "r", status: "FINISHED" }, Date.now()).status, "finished");
  });

  it("adds the three display fields without touching the facts", () => {
    const entry = fleetEntry();
    const decorated = decorate(entry, Date.now());
    assert.equal(decorated.agent, entry.agent);
    assert.equal(decorated.branch, entry.branch);
    assert.deepEqual(
      Object.keys(decorated).filter((key) => !(key in entry)).sort(),
      ["active", "age", "status"],
    );
  });
});

/* ── The credential sweep ────────────────────────────────────────────────── */

describe("nothing a page handler answers carries a credential", () => {
  /** Field names that would be a credential if they held a string. */
  const CREDENTIAL_KEYS = new Set([
    "token", "accesstoken", "refreshtoken", "apikey", "secret", "clientsecret",
    "password", "authorization", "credential", "key", "providerkey",
  ]);

  /** Values that ARE a credential in this test's world. */
  const NEEDLES = [FAKE_KEY, "key_cursor_", "Bearer "];

  function sweep(value, path, found) {
    if (typeof value === "string") {
      for (const needle of NEEDLES) {
        if (value.includes(needle)) found.push(`${path} = ${needle}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => sweep(entry, `${path}[${index}]`, found));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (CREDENTIAL_KEYS.has(key.toLowerCase())) found.push(`${path}.${key} is a credential-shaped field`);
      sweep(entry, `${path}.${key}`, found);
    }
  }

  it("walks every handler's result and finds none", async () => {
    const { actions } = makeDeps({
      collections: { "laneSecrets/lane:lane-1": { names: ["DATABASE_URL"] } },
    });

    const calls = [
      ["pageFleet", {}],
      ["pageAgent", { agentId: "bc_abc123" }],
      ["pageLaunchContext", { laneId: "lane-1" }],
      ["pageConnection", {}],
      ["pageLaunch", { prompt: "fix it", laneId: "lane-1" }],
      ["pageOpenInAde", { agentId: "bc_abc123" }],
      ["pageStopRun", { agentId: "bc_abc123" }],
      ["pageFollowUp", { agentId: "bc_abc123", prompt: "more" }],
      ["pagePullIntoLane", { agentId: "bc_abc123" }],
      ["pageArchiveAgent", { agentId: "bc_abc123" }],
      ["pageUnarchiveAgent", { agentId: "bc_abc123" }],
      ["pageDeleteAgent", { agentId: "bc_abc123" }],
      ["pageAckBadge", {}],
      ["pageCopyWebhookUrl", {}],
    ];

    const found = [];
    for (const [id, args] of calls) {
      assert.equal(typeof actions[id], "function", `${id} is missing from the page table`);
      sweep(await actions[id](args), id, found);
    }
    assert.deepEqual(found, [], found.join("; "));
    // Every id the contract names was exercised above; a new one is a new case.
    assert.equal(calls.length, Object.keys(actions).length, "a page action has no secret-sweep case");
  });
});
