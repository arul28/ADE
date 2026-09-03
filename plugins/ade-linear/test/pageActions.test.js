// The page tier's action table, against the real data layer and a fake Linear.
//
// These handlers are the ONLY thing between an ordinary web page and the
// machine's Linear credential, so the cases here are written around the three
// failures that would matter most:
//
//   * a read that answers a shape the page cannot draw — a missing field is a
//     blank column, and `page/src/types.ts` is the contract that says which;
//   * a mutation that THROWS where the page expected `{ok, message}` — a
//     rejected promise beside a filled-in form is the wrong shape for a form;
//   * a result carrying a credential. The webview bridge exposes no `secrets`
//     verb on purpose, and a token that leaked through a data field would undo
//     that with nothing anywhere reporting it. The last case in this file walks
//     every handler's result and fails on one.
//
// The collaborators are the REAL `data`, `flows`, `connect` and `automation`
// built over `test/support.js`'s fakes, rather than a recorder: what these
// handlers are is a mapping onto those four, and a test that stubbed them would
// pass while the mapping was wrong.

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createPageActions, pageIssue, slugify } = require("../pageActions");
const { createData } = require("../data");
const { createFlows } = require("../flows");
const { createConnect } = require("../connect");
const { createAutomation } = require("../automation");
const { issueIdFromRowKey } = require("../panels/rows");
const { createApi, createSdk, createSecrets, issueNode } = require("./support");

/** The token the fake credential holds, so the secret sweep has a needle. */
const FAKE_TOKEN = "lin_api_abcdefghijklmnopqrstuvwxyz0123";

/**
 * A Linear `request` fake that answers the three page-only queries.
 *
 * Dispatched on the operation name in the query text, because that is what
 * distinguishes them — `pageActions.js` sends one query per read and a test
 * that matched on argument order would pass for the wrong one.
 */
function makeRequest(answers = {}) {
  const calls = [];
  return Object.assign(
    async (query) => {
      calls.push(query);
      if (query.includes("PageIdentity")) {
        if (answers.identityThrows) throw answers.identityThrows;
        return answers.identity === null ? {} : (answers.identity ?? {
          viewer: {
            id: "user-1",
            name: "Ada",
            displayName: "Ada L",
            email: "ada@acme.test",
            avatarUrl: "https://acme.test/ada.png",
            admin: true,
            guest: false,
            url: "https://linear.app/acme/profiles/ada",
          },
          organization: {
            id: "org-1",
            name: "Acme",
            urlKey: "acme",
            logoUrl: null,
            gitBranchFormat: "{issue}-{title}",
            createdIssueCount: 412,
          },
        });
      }
      if (query.includes("PageProjects")) {
        if (answers.projectsThrows) throw answers.projectsThrows;
        return {
          projects: {
            nodes: answers.projects ?? [{
              id: "proj-1",
              name: "Platform",
              slugId: "platform",
              icon: "🛠",
              color: "#40f",
              description: "The platform work.",
              url: "https://linear.app/acme/project/platform",
              progress: 0.5,
              scope: 12,
              startDate: "2026-08-01",
              targetDate: "2026-10-01",
              health: "onTrack",
              status: { name: "In Progress", type: "started" },
              lead: { id: "user-1", name: "Ada", displayName: "Ada L" },
              teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] },
            }],
          },
        };
      }
      if (query.includes("PageUsers")) {
        if (answers.usersThrows) throw answers.usersThrows;
        return {
          users: {
            nodes: answers.users ?? [
              { id: "user-1", name: "Ada", displayName: "Ada L", email: "ada@acme.test", active: true },
            ],
          },
        };
      }
      return {};
    },
    { calls },
  );
}

const TEAM_NODE = {
  id: "team-1",
  key: "ENG",
  name: "Engineering",
  states: { nodes: [{ id: "state-started", name: "In Progress", type: "started" }] },
};

/**
 * The whole dependency frame `index.js` builds, with the lifecycle's four
 * functions replaced by recorders.
 */
function makeDeps(options = {}) {
  const secrets = createSecrets({
    ...(options.noToken === true ? {} : { LINEAR_ACCESS_TOKEN: FAKE_TOKEN, LINEAR_AUTH_MODE: "manual" }),
    ...(options.webhookSecret === false ? {} : { LINEAR_WEBHOOK_SECRET: "whsec_abcdef123456" }),
  });
  const sdk = createSdk({
    secrets,
    lanes: options.lanes ?? [],
    sessionIssues: options.sessionIssues ?? {},
    ...(options.officialClient !== undefined ? { officialClient: options.officialClient } : {}),
    ...(options.webhookStatus !== undefined ? { webhookStatus: options.webhookStatus } : {}),
    ...(options.webhookUrlThrows === true ? { webhookUrlThrows: true } : {}),
    actions: {
      // Provider-aware, because `pageModels` now asks once per provider group
      // and the group it asked for is what tags the row. A fixture that
      // answered the same list to every group would hide exactly the bug the
      // per-provider read exists to fix.
      "chat.getAvailableModels": async (args) => {
        if (options.models) return options.models;
        const byProvider = {
          claude: [
            {
              id: "anthropic/opus-5",
              displayName: "Opus 5",
              serviceTiers: ["standard", "fast"],
              reasoningEfforts: [
                { effort: "low", description: "Quick" },
                { effort: "high", description: "Careful" },
              ],
              defaultReasoningEffort: "low",
            },
          ],
          codex: [{ id: "codex/gpt-5.6", displayName: "GPT 5.6" }, "codex/gpt-5.6-mini"],
        };
        return byProvider[args?.provider] ?? [];
      },
      "git.getOriginRemote": async () => "https://github.com/acme/app.git",
      "github.listRepoAutolinks": async () => options.autolinks ?? [
        { id: 7, keyPrefix: "ENG-", urlTemplate: "https://linear.app/acme/issue/ENG-<num>", isAlphanumeric: false },
      ],
      "github.createRepoAutolink": async () => ({ ok: true }),
      "lane.create": async (args) => ({ id: "lane-new", name: args.name, branchRef: args.branchName }),
      "lane.delete": async () => {
        if (options.deleteLaneThrows) throw options.deleteLaneThrows;
        return null;
      },
      "chat.createSession": async () => ({ sessionId: "session-1" }),
      "chat.launchCli": async () => ({ sessionId: "session-cli" }),
      ...(options.actions ?? {}),
    },
  });

  const api = createApi({
    request: makeRequest(options.answers ?? {}),
    /**
     * Read back out of the fake keychain rather than answering a constant, so
     * `pageSaveApiKey` and `pageDisconnect` change what every later read sees —
     * which is the whole observable effect of both of them.
     */
    async readCredential() {
      const token = await secrets.get("LINEAR_ACCESS_TOKEN");
      return {
        token,
        authMode: await secrets.get("LINEAR_AUTH_MODE"),
        expiresAt: options.expiresAt ?? null,
        refreshToken: null,
        clientId: null,
      };
    },
    async searchAllIssues() {
      if (options.searchAllThrows) throw options.searchAllThrows;
      return options.issues ?? [issueNode()];
    },
    async searchIssues(query) {
      searched.push(query);
      if (options.searchThrows) throw options.searchThrows;
      return options.page ?? { nodes: [issueNode()], hasNextPage: true, endCursor: "cursor-2" };
    },
    async fetchIssueById() {
      return options.issue === null ? null : (options.issue ?? issueNode());
    },
    async fetchIssueComments() {
      if (options.commentsThrow) throw options.commentsThrow;
      return options.comments ?? [
        { id: "c1", body: "Looks good.", createdAt: "2026-08-21T00:00:00.000Z", user: { id: "user-1", name: "Ada", displayName: "Ada L" } },
      ];
    },
    async listTeamsAndStates() {
      return options.teams ?? [TEAM_NODE];
    },
    async updateIssueState() {
      if (options.stateThrows) throw options.stateThrows;
    },
    async updateIssuePriority() {
      if (options.priorityThrows) throw options.priorityThrows;
    },
    async updateIssueAssignee() {
      if (options.assignThrows) throw options.assignThrows;
    },
    async createComment() {
      if (options.commentThrows) throw options.commentThrows;
      return "comment-1";
    },
    async addLabel() {
      if (options.labelThrows) throw options.labelThrows;
      return "label-1";
    },
    ...(options.api ?? {}),
  });

  const searched = [];
  const data = createData({ sdk, api });
  const flows = createFlows({ sdk, api, data });
  const connect = createConnect({ sdk, api, data });
  const automation = createAutomation({ api, data, flows });
  const published = [];
  const refreshed = [];

  const deps = {
    sdk,
    api,
    data,
    flows,
    connect,
    automation,
    publish: async (panelId) => { published.push(panelId); },
    refreshIssues: async () => { refreshed.push("issues"); return { state: "list", count: 0 }; },
    refreshCatalogAndIssues: async () => { refreshed.push("catalog"); },
    ensureIssues: async () => {},
    webhooksReachable: (status) => status?.clientSource === "official" || status?.clientSource === "custom",
    chosenReasoningEffort: (value) => {
      const text = typeof value === "string" ? value.trim() : "";
      return text && text !== "default" ? text : null;
    },
    issueIdFromRowKey,
  };

  return { actions: createPageActions(deps), api, data, deps, published, refreshed, sdk, searched };
}

/** The sdk calls of one domain.action, in order. */
function invocations(sdk, name) {
  return sdk.calls.filter((entry) => entry[0] === `actions.${name}`).map((entry) => entry[1]);
}

describe("the reads answer the shapes page/src/types.ts declares", () => {
  it("builds a quick view on a cold start, from Linear rather than the collections", async () => {
    // Nothing has been refreshed and no row has been written: this is the first
    // thing the browser asks for, and a machine that answered "not connected"
    // here would draw its connect card over a working credential.
    const { actions } = makeDeps();
    const view = await actions.pageQuickView();

    assert.deepEqual(Object.keys(view).sort(), [
      "assignedIssues", "connection", "fetchedAt", "organization", "projects", "recentIssues", "teams", "viewer",
    ]);
    assert.equal(view.connection.connected, true);
    assert.equal(view.viewer.email, "ada@acme.test");
    assert.equal(view.viewer.admin, true);
    assert.equal(view.organization.gitBranchFormat, "{issue}-{title}");
    assert.equal(view.organization.createdIssueCount, 412);
    assert.equal(view.projects[0].slug, "platform");
    assert.equal(view.projects[0].health, "onTrack");
    assert.deepEqual(view.projects[0].teamKeys, ["ENG"]);
    assert.deepEqual(Object.keys(view.teams[0]).sort(), [
      "color", "cyclesEnabled", "displayName", "id", "issueCount", "key", "name", "private",
    ]);
    assert.equal(view.teams[0].key, "ENG");
    assert.equal(view.assignedIssues[0].identifier, "ENG-1");
    assert.equal(view.recentIssues[0].identifier, "ENG-1");
    assert.ok(!Number.isNaN(Date.parse(view.fetchedAt)));
  });

  it("normalizes an issue into the page's shape, not the panel's", async () => {
    const { actions } = makeDeps();
    const view = await actions.pageQuickView();
    const issue = view.recentIssues[0];

    // The page reads label NAMES and `childIssues`; the stored row holds label
    // objects and `subIssues`. A page handed the row would draw `[object
    // Object]` chips and no sub-issues at all.
    assert.deepEqual(issue.labels, ["bug"]);
    assert.deepEqual(issue.labelColors, [{ name: "bug", color: "#f00" }]);
    assert.deepEqual(issue.childIssues, []);
    // The page's five-value union, NOT `panels/contract.js`'s "High".
    assert.equal(issue.priority, 2);
    assert.equal(issue.priorityLabel, "high");
    assert.equal(issue.projectSlug, "platform");
    assert.equal(issue.ownerId, "user-1");
    assert.deepEqual(issue.blockerIssueIds, []);
    assert.equal(issue.hasOpenBlockers, false);
    for (const field of ["id", "identifier", "title", "description", "teamKey", "stateType", "createdAt", "updatedAt"]) {
      assert.equal(typeof issue[field], "string", `${field} must always be a string`);
    }
  });

  it("carries Linear's own project slug, cycle id and blockers rather than deriving or dropping them", async () => {
    // The three fields the page could previously only guess at or show empty.
    // `projectSlug` was derived from the project NAME because the selection
    // took `project { id name }`; `cycleId` was hard-coded null beside a
    // `cycleName` that was real; and the blocker badge could never light.
    const blocked = issueNode({
      project: { id: "proj-1", name: "Platform", slugId: "platform-a1b2" },
      cycle: { id: "cycle-9", name: "Sprint 14", number: 14 },
      inverseRelations: {
        nodes: [
          { id: "rel-1", type: "blocks", issue: { id: "issue-9", identifier: "ENG-9", state: { id: "s", name: "Todo", type: "unstarted" } } },
          { id: "rel-2", type: "blocks", issue: { id: "issue-8", identifier: "ENG-8", state: { id: "s2", name: "Done", type: "completed" } } },
          // Not a blocker: `related` says nothing about order of work.
          { id: "rel-3", type: "related", issue: { id: "issue-7", identifier: "ENG-7", state: { id: "s3", name: "Todo", type: "unstarted" } } },
        ],
      },
    });
    const { actions } = makeDeps({ issues: [blocked] });
    const issue = (await actions.pageQuickView()).recentIssues[0];

    assert.equal(issue.projectSlug, "platform-a1b2");
    assert.equal(issue.cycleId, "cycle-9");
    assert.equal(issue.cycleName, "Sprint 14");
    assert.deepEqual(issue.blockerIssueIds, ["issue-9", "issue-8"]);
    // One of the two is still open, which is what the badge asks about.
    assert.equal(issue.hasOpenBlockers, true);
  });

  it("reads a finished blocker as no longer blocking", async () => {
    const done = issueNode({
      inverseRelations: {
        nodes: [
          { id: "rel-1", type: "blocks", issue: { id: "issue-8", identifier: "ENG-8", state: { id: "s", name: "Done", type: "completed" } } },
          { id: "rel-2", type: "blocks", issue: { id: "issue-7", identifier: "ENG-7", state: { id: "s2", name: "Cancelled", type: "canceled" } } },
        ],
      },
    });
    const { actions } = makeDeps({ issues: [done] });
    const issue = (await actions.pageQuickView()).recentIssues[0];
    assert.deepEqual(issue.blockerIssueIds, ["issue-8", "issue-7"]);
    assert.equal(issue.hasOpenBlockers, false);
  });

  it("falls back to a slug derived from the name when the workspace answered none", async () => {
    const { actions } = makeDeps();
    const issue = (await actions.pageQuickView()).recentIssues[0];
    assert.equal(issue.projectSlug, "platform");
  });

  it("resolves an issue from its id alone, which no search can do", async () => {
    // The lane row badge's whole failure mode: a pointer carrying a uuid and no
    // key anywhere on the row. Linear's search does not match a raw id, so the
    // card used to say "No Linear issue on this lane" about an issue that
    // plainly exists.
    const { actions, data } = makeDeps();
    await data.refreshIssues();
    const issue = await actions.pageIssueById({ issueId: "issue-1" });
    assert.equal(issue.id, "issue-1");
    assert.equal(issue.identifier, "ENG-1");
  });

  it("answers null for an id no workspace can name, rather than throwing at the card", async () => {
    const { actions } = makeDeps({ issue: null });
    assert.equal(await actions.pageIssueById({ issueId: "issue-nope" }), null);
    assert.equal(await actions.pageIssueById({}), null);
  });

  it("answers a quick view with no Linear behind it rather than throwing", async () => {
    const { actions } = makeDeps({ noToken: true });
    const view = await actions.pageQuickView();
    assert.equal(view.connection.connected, false);
    assert.equal(view.connection.tokenStored, false);
    assert.deepEqual(view.projects, []);
    assert.deepEqual(view.assignedIssues, []);
    assert.equal(view.viewer, null);
    assert.equal(view.organization, null);
  });

  it("falls back to the connection row when the identity query is refused", async () => {
    const { actions } = makeDeps({ answers: { identityThrows: new Error("500") } });
    const view = await actions.pageQuickView();
    // Four fields rather than eight, and a page that draws a header rather than
    // an error over a connection that plainly works.
    assert.equal(view.viewer.id, "user-1");
    assert.equal(view.viewer.email, null);
    assert.equal(view.organization.name, "Acme");
    assert.equal(view.organization.gitBranchFormat, null);
  });

  it("answers the picker catalog with projects, users and states", async () => {
    const { actions } = makeDeps();
    const catalog = await actions.pageCatalog();
    assert.deepEqual(Object.keys(catalog).sort(), ["projects", "states", "users"]);
    assert.deepEqual(Object.keys(catalog.projects[0]).sort(), [
      "color", "icon", "id", "name", "slug", "teamKey", "teamName",
    ]);
    assert.deepEqual(catalog.users, [
      { id: "user-1", name: "Ada", displayName: "Ada L", email: "ada@acme.test", active: true },
    ]);
    // The states come from the CATALOG, fetched because nothing had read it yet.
    assert.deepEqual(catalog.states, [
      { id: "state-started", name: "In Progress", type: "started", teamId: "team-1", teamKey: "ENG" },
    ]);
  });

  it("derives the people from the issues when Linear refuses the user query", async () => {
    const { actions, data } = makeDeps({ answers: { usersThrows: new Error("403") } });
    await data.refreshIssues();
    const catalog = await actions.pageCatalog();
    assert.deepEqual(catalog.users, [
      { id: "user-1", name: "Ada L", displayName: "Ada L", email: null, active: true },
    ]);
  });

  it("honours the search cursor and caps a page at Linear's own ceiling", async () => {
    const { actions, searched } = makeDeps();
    const result = await actions.pageSearchIssues({
      first: 500,
      after: "cursor-1",
      teamKey: "eng",
      stateTypes: ["started"],
      priority: 0,
      query: "oauth",
      includeArchived: true,
    });

    // 500 asked, 100 sent: Linear clamps above 100 without saying so, and a page
    // that believed it had 500 rows would stop scrolling five screens in.
    assert.equal(searched[0].first, 100);
    assert.equal(searched[0].after, "cursor-1");
    assert.equal(searched[0].teamKey, "ENG");
    assert.deepEqual(searched[0].stateTypes, ["started"]);
    // `0` is "no priority" and a real filter, so it must survive the coercion.
    assert.equal(searched[0].priority, 0);
    assert.equal(searched[0].includeArchived, true);
    assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "cursor-2" });
    assert.equal(result.issues[0].identifier, "ENG-1");
  });

  it("resolves a project SLUG to the id Linear's filter actually takes", async () => {
    // `IssueFilter` has no slug clause at all, so a page filtering by slug would
    // silently filter by nothing.
    const { actions, searched } = makeDeps();
    await actions.pageSearchIssues({ projectSlug: "platform" });
    assert.equal(searched[0].projectId, "proj-1");
  });

  it("rejects a refused search rather than answering an empty page", async () => {
    // An empty page and "Linear is rate limiting you" are the same value in this
    // shape, and the page cannot tell them apart.
    const { actions } = makeDeps({ searchThrows: new Error("rate limited") });
    await assert.rejects(() => actions.pageSearchIssues({}), /rate limited/);
  });

  it("answers one issue's comments in the page's five fields", async () => {
    const { actions } = makeDeps();
    const comments = await actions.pageIssueComments({ issueId: "issue-1" });
    assert.deepEqual(comments, [{
      id: "c1",
      body: "Looks good.",
      createdAt: "2026-08-21T00:00:00.000Z",
      userName: "Ada",
      userDisplayName: "Ada L",
    }]);
  });

  it("answers the connection card without any part of the credential", async () => {
    const { actions } = makeDeps();
    const connection = await actions.pageConnection();
    assert.deepEqual(Object.keys(connection).sort(), [
      "authMode", "checkedAt", "connected", "expired", "expiresIn", "message", "oauthAvailable",
      "organizationId", "organizationLogoUrl", "organizationName", "organizationUrlKey",
      "projectCount", "projectPreview", "tokenExpiresAt", "tokenStored", "viewerId", "viewerName",
    ]);
    assert.equal(connection.tokenStored, true);
    assert.equal(connection.connected, true);
    assert.equal(connection.authMode, "manual");
    assert.equal(connection.oauthAvailable, true);
    // An API-key connection has no expiry, and the card says nothing rather
    // than "never".
    assert.equal(connection.expiresIn, null);
    assert.equal(connection.expired, false);
  });

  it("pre-formats the token's remaining life, and says so when it has run out", async () => {
    // The settings PAGE draws this in the connected card and the settings PANEL
    // draws it as a row. One function behind both, so the two cannot round the
    // same instant differently.
    const soon = new Date(Date.now() + 6 * 86_400_000).toISOString();
    const live = await makeDeps({ expiresAt: soon }).actions.pageConnection();
    assert.equal(live.expiresIn, "expires in 6 days");
    assert.equal(live.expired, false);

    const past = new Date(Date.now() - 60_000).toISOString();
    const dead = await makeDeps({ expiresAt: past }).actions.pageConnection();
    assert.equal(dead.expiresIn, "expired");
    assert.equal(dead.expired, true);
  });

  it("answers the projects list", async () => {
    const { actions } = makeDeps();
    const projects = await actions.pageProjects();
    assert.equal(projects.length, 1);
    assert.deepEqual(Object.keys(projects[0]).sort(), [
      "color", "icon", "id", "name", "slug", "teamKey", "teamName",
    ]);
  });

  it("answers the autolink card with what GitHub already has", async () => {
    const { actions } = makeDeps();
    const state = await actions.pageAutolinks();
    assert.deepEqual(Object.keys(state).sort(), [
      "autolinks", "drainError", "lastEvent", "pendingDeliveries", "repo", "teams",
      "webhookSecretStored", "webhookUrl", "webhooksPossible",
    ]);
    assert.deepEqual(state.autolinks, [{
      id: 7,
      keyPrefix: "ENG-",
      urlTemplate: "https://linear.app/acme/issue/ENG-<num>",
      isAlphanumeric: false,
    }]);
    assert.deepEqual(state.repo, { owner: "acme", name: "app" });
    assert.deepEqual(state.teams, [{
      teamKey: "ENG",
      teamName: "Engineering",
      keyPrefix: "ENG-",
      urlTemplate: "https://linear.app/acme/issue/ENG-<num>",
    }]);
    // The BOOLEAN. The secret itself never crosses the bridge.
    assert.equal(state.webhookSecretStored, true);
    assert.equal(typeof state.webhookUrl, "string");
    // The same rule the settings panel prints, from the same function: whether
    // an OAuth client exists at all to carry the `admin` grant Linear delivers
    // webhooks to. A machine ADE lends nothing gets `false`.
    assert.equal(state.webhooksPossible, true);
    const alone = makeDeps({ officialClient: null });
    assert.equal((await alone.actions.pageAutolinks()).webhooksPossible, false);
  });

  it("carries the delivery ledger's three rows, pre-formatted the way the panel prints them", async () => {
    const { actions } = makeDeps({
      webhookStatus: {
        lastReceivedAt: "2026-09-01T12:00:34.000Z",
        pendingDeliveries: 2,
        lastError: "relay timed out",
      },
    });
    const state = await actions.pageAutolinks();
    assert.equal(state.lastEvent, "2026-09-01 12:00 UTC");
    assert.equal(state.pendingDeliveries, 2);
    assert.equal(state.drainError, "relay timed out");
  });

  it("says nothing about deliveries when there is no endpoint to deliver to", async () => {
    // A ledger read with no `webhookUrl` would answer zeros, and a card drawing
    // "0 unacked" beside "Not set up" reads as a healthy silence.
    const { actions } = makeDeps({ webhookUrlThrows: true });
    const state = await actions.pageAutolinks();
    assert.equal(state.webhookUrl, null);
    assert.equal(state.lastEvent, null);
    assert.equal(state.pendingDeliveries, 0);
    assert.equal(state.drainError, null);
  });

  it("reports the issues linked to the CHATS in a lane, not just the lane", async () => {
    // Without this the launch flow cannot tell "this lane exists on the issue"
    // from "this lane has an agent on the issue", and warns the wrong way.
    const { actions } = makeDeps({
      lanes: [{
        id: "lane-1",
        name: "ENG-1 Fix the thing",
        branchRef: "eng-1-fix-the-thing",
        status: "active",
        laneType: "worktree",
        primaryIssue: { provider: "linear", issueId: "issue-1", key: "ENG-1" },
        issueLinks: [],
      }],
      sessionIssues: {
        "lane-1": [{
          sessionId: "session-9",
          issueLinks: [
            { issue: { provider: "linear", issueId: "issue-2", key: "ENG-2" }, closeOnMerge: true },
            { issue: { provider: "jira", issueId: "JIRA-1", key: "JIRA-1" } },
          ],
        }],
      },
    });

    const lanes = await actions.pageLanes();
    assert.equal(lanes.length, 1);
    assert.deepEqual(Object.keys(lanes[0]).sort(), [
      "branch", "id", "laneType", "linearIssueId", "linearIssueKey", "linearIssueLinks", "name", "path", "status",
    ]);
    assert.equal(lanes[0].branch, "eng-1-fix-the-thing");
    assert.equal(lanes[0].linearIssueKey, "ENG-1");
    // Only Linear's. A Jira link on the same session belongs to another plugin.
    assert.deepEqual(lanes[0].linearIssueLinks, [
      { issueId: "issue-2", issueKey: "ENG-2", sessionId: "session-9" },
    ]);
    // Null on a host whose lane summary still withholds the worktree. The page
    // hides the row rather than drawing an empty one.
    assert.equal(lanes[0].path, null);
  });

  it("carries the lane's worktree path under either name the host may use", async () => {
    const withPath = await makeDeps({
      lanes: [
        { id: "lane-a", name: "A", branchRef: "refs/heads/a", path: "/w/a" },
        { id: "lane-b", name: "B", branchRef: "refs/heads/b", worktreePath: "/w/b" },
      ],
    }).actions.pageLanes();
    assert.deepEqual(withPath.map((lane) => lane.path), ["/w/a", "/w/b"]);
  });

  it("tags every model with the provider the read asked for, never with its id prefix", async () => {
    // The whole reason the read is per-provider: the row itself carries no
    // provider, and the launch form's permission control is a different
    // vocabulary for each one. `codex/gpt-5.6-mini` is the case a prefix guess
    // gets right by accident and `anthropic/opus-5` is the one it gets wrong —
    // that model is a CLAUDE model whichever way its id reads.
    const { actions } = makeDeps();
    assert.deepEqual(await actions.pageModels(), [
      {
        id: "anthropic/opus-5",
        label: "Opus 5",
        provider: "claude",
        fastModeSupported: true,
        reasoningEfforts: [
          { value: "low", label: "low", detail: "Quick" },
          { value: "high", label: "high", detail: "Careful" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        id: "codex/gpt-5.6",
        label: "GPT 5.6",
        provider: "codex",
        fastModeSupported: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
      },
      {
        id: "codex/gpt-5.6-mini",
        label: "codex/gpt-5.6-mini",
        provider: "codex",
        fastModeSupported: false,
        reasoningEfforts: [],
        defaultReasoningEffort: null,
      },
    ]);
  });

  it("offers a permission vocabulary per provider, every option mapping to a value ADE accepts", async () => {
    // `chat.createSession` validates `AgentChatPermissionMode` and nothing
    // else. A picker offering a seventh value would be refused at launch, which
    // is the failure this table exists to prevent.
    const ACCEPTED = new Set(["default", "auto", "plan", "edit", "full-auto", "config-toml"]);
    const { actions } = makeDeps();
    const { providers } = await actions.pageCapabilities();
    assert.deepEqual(
      Object.keys(providers).sort(),
      ["claude", "codex", "cursor", "droid", "opencode"],
    );
    for (const [provider, entry] of Object.entries(providers)) {
      assert.ok(entry.modes.length > 0, `${provider} offers no permission modes`);
      for (const mode of entry.modes) {
        assert.ok(ACCEPTED.has(mode.unified), `${provider}.${mode.value} maps to ${mode.unified}`);
        assert.equal(typeof mode.label, "string");
      }
    }
    // The provider's OWN word, not the unified one: a Droid reader picks
    // "Auto medium", which ADE receives as "default".
    const droid = providers.droid.modes.find((mode) => mode.value === "auto-medium");
    assert.equal(droid.label, "Auto medium");
    assert.equal(droid.unified, "default");
  });

  it("answers empty shapes rather than throwing before activate has run", async () => {
    // The page is a webview the reader can open the instant the tab is drawn,
    // which is well before the first Linear read has settled.
    const cold = createPageActions({
      publish: async () => {},
      refreshIssues: async () => {},
      refreshCatalogAndIssues: async () => {},
      webhooksReachable: () => false,
      chosenReasoningEffort: () => null,
      issueIdFromRowKey,
    });
    assert.deepEqual(await cold.pageLanes(), []);
    assert.deepEqual(await cold.pageProjects(), []);
    assert.deepEqual(await cold.pageModels(), []);
    assert.equal((await cold.pageConnection()).connected, false);
    assert.equal((await cold.pageQuickView()).viewer, null);
    assert.equal((await cold.pageSetIssueState({ issueId: "i", stateId: "s" })).ok, false);
  });
});

describe("the issue mutations answer a form, never a rejection", () => {
  it("moves an issue and republishes the panels that were showing it", async () => {
    const { actions, published } = makeDeps();
    const result = await actions.pageSetIssueState({ issueId: "issue-1", stateId: "state-done" });
    assert.deepEqual(result, { ok: true, message: "State updated." });
    // The vocabulary surfaces and the page must not end up disagreeing about an
    // issue the page just changed.
    assert.deepEqual(published, ["issue", "issues"]);
  });

  it("answers Linear's refusal as a message rather than throwing it", async () => {
    const { actions } = makeDeps({ stateThrows: new Error("Linear refused the state change.") });
    assert.deepEqual(await actions.pageSetIssueState({ issueId: "issue-1", stateId: "state-done" }), {
      ok: false,
      message: "Linear refused the state change.",
    });
  });

  it("refuses a state change with nothing to change it to", async () => {
    const { actions } = makeDeps();
    assert.equal((await actions.pageSetIssueState({ issueId: "issue-1" })).ok, false);
    assert.equal((await actions.pageSetIssueState({ stateId: "state-done" })).ok, false);
  });

  it("sets a priority, and keeps 0 as the real choice it is", async () => {
    const seen = [];
    const { actions } = makeDeps({ api: { updateIssuePriority: async (id, priority) => { seen.push([id, priority]); } } });
    assert.deepEqual(await actions.pageSetIssuePriority({ issueId: "issue-1", priority: 0 }), {
      ok: true,
      message: "Priority updated.",
    });
    assert.deepEqual(seen, [["issue-1", 0]]);
    // A priority that never arrived is refused; it is not silently "none".
    assert.equal((await actions.pageSetIssuePriority({ issueId: "issue-1" })).ok, false);
  });

  it("reports a refused priority", async () => {
    const { actions } = makeDeps({ priorityThrows: new Error("A Linear priority is 0 (none) to 4 (low).") });
    const result = await actions.pageSetIssuePriority({ issueId: "issue-1", priority: 2 });
    assert.equal(result.ok, false);
    assert.match(result.message, /0 \(none\)/);
  });

  it("assigns, and says so differently when the assignee is cleared", async () => {
    const { actions } = makeDeps();
    assert.deepEqual(await actions.pageAssignIssue({ issueId: "issue-1", assigneeId: "user-2" }), {
      ok: true,
      message: "Assignee updated.",
    });
    assert.deepEqual(await actions.pageAssignIssue({ issueId: "issue-1", assigneeId: null }), {
      ok: true,
      message: "Assignee cleared.",
    });
  });

  it("reports a refused assignment", async () => {
    const { actions } = makeDeps({ assignThrows: new Error("Linear refused this credential.") });
    assert.deepEqual(await actions.pageAssignIssue({ issueId: "issue-1", assigneeId: "user-2" }), {
      ok: false,
      message: "Linear refused this credential.",
    });
  });

  it("comments, and refuses an empty body before it reaches Linear", async () => {
    const { actions } = makeDeps();
    assert.deepEqual(await actions.pageAddComment({ issueId: "issue-1", body: " Shipped. " }), {
      ok: true,
      message: "Comment posted.",
    });
    assert.deepEqual(await actions.pageAddComment({ issueId: "issue-1", body: "   " }), {
      ok: false,
      message: "A comment needs a body.",
    });
  });

  it("reports a refused comment", async () => {
    const { actions } = makeDeps({ commentThrows: new Error("Linear is rate limiting this credential.") });
    const result = await actions.pageAddComment({ issueId: "issue-1", body: "Shipped." });
    assert.equal(result.ok, false);
    assert.match(result.message, /rate limiting/);
  });

  it("adds a label, and reports a name Linear does not have", async () => {
    const { actions } = makeDeps();
    assert.deepEqual(await actions.pageAddLabel({ issueId: "issue-1", labelName: "bug" }), {
      ok: true,
      message: "Added bug.",
    });

    const refused = makeDeps({ labelThrows: new Error('Linear has no label called "nope".') });
    const result = await refused.actions.pageAddLabel({ issueId: "issue-1", labelName: "nope" });
    assert.equal(result.ok, false);
    assert.match(result.message, /no label called/);
  });

  it("says to connect rather than naming a missing token", async () => {
    const missing = new Error("No Linear credential is stored for this plugin.");
    missing.code = "no_token";
    const { actions } = makeDeps({ stateThrows: missing });
    assert.deepEqual(await actions.pageSetIssueState({ issueId: "issue-1", stateId: "s" }), {
      ok: false,
      message: "Connect Linear in Settings → Linear.",
    });
  });
});

describe("the connection", () => {
  it("begins the sign-in and hands the host the session it started", async () => {
    const { actions, sdk } = makeDeps();
    const result = await actions.pageConnectOAuth({ origin: "settings" });
    // `{authSession}` verbatim: the HOST stamps the live URL and the client
    // presents it. A plugin that built its own URL could point one elsewhere.
    assert.deepEqual(result, { ok: true, message: null, authSession: { sessionId: "linear" } });
    // Started, not polled: `auth.completed` reaches `index.js`.
    assert.equal(sdk.calls.filter((entry) => entry[0] === "auth.beginSession").length, 1);
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  });

  it("reports a machine with no OAuth client instead of a sign-in that never opens", async () => {
    const { actions } = makeDeps({ officialClient: null });
    const result = await actions.pageConnectOAuth({});
    assert.equal(result.ok, false);
    assert.match(result.message, /API key/);
    assert.equal("authSession" in result, false);
  });

  it("saves an API key and answers the connection it produced, never the key", async () => {
    const { actions, refreshed } = makeDeps({ noToken: true });
    assert.equal((await actions.pageConnection()).connected, false);
    const result = await actions.pageSaveApiKey({ token: FAKE_TOKEN });
    assert.equal(result.ok, true);
    assert.equal(result.connection.tokenStored, true);
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
    assert.deepEqual(refreshed, ["catalog"]);
  });

  it("refuses a pasted OAuth token where an API key belongs, without echoing it", async () => {
    const { actions } = makeDeps();
    const result = await actions.pageSaveApiKey({ token: "not-a-linear-key" });
    assert.equal(result.ok, false);
    assert.match(result.message, /lin_api_/);
    assert.equal(JSON.stringify(result).includes("not-a-linear-key"), false);
  });

  it("disconnects and answers the connection that is left", async () => {
    const { actions, published } = makeDeps();
    const result = await actions.pageDisconnect();
    assert.equal(result.ok, true);
    assert.equal(result.connection.connected, false);
    assert.deepEqual(published, ["settings", "issues"]);
  });

  it("takes a bare autolink prefix, whatever case it arrives in", async () => {
    const { actions, sdk, data } = makeDeps();
    await data.refreshCatalog(null);
    await data.refreshConnection();
    const result = await actions.pageCreateAutolink({ teamKey: "eng-" });
    assert.equal(result.ok, true);
    const created = invocations(sdk, "github.createRepoAutolink");
    assert.equal(created.length, 1);
    assert.equal(created[0].keyPrefix, "ENG-");
  });

  it("refuses a prefix that names no team rather than linking to a Linear 404", async () => {
    // The compiled section offers an `ADEPR` row that belongs to no Linear team.
    const { actions, sdk, data } = makeDeps();
    await data.refreshCatalog(null);
    const result = await actions.pageCreateAutolink({ teamKey: "ADEPR" });
    assert.equal(result.ok, false);
    assert.match(result.message, /No Linear team here uses the ADEPR prefix/);
    assert.deepEqual(invocations(sdk, "github.createRepoAutolink"), []);
  });

  it("refuses an autolink with no prefix at all", async () => {
    const { actions } = makeDeps();
    assert.equal((await actions.pageCreateAutolink({})).ok, false);
  });
});

describe("lanes, chats and launches", () => {
  it("creates a lane through the flow that derives Linear's own branch name", async () => {
    const { actions, sdk } = makeDeps();
    const result = await actions.pageCreateLane({ issueId: "issue-1", baseRef: "main" });
    assert.equal(result.ok, true);
    assert.equal(result.laneId, "lane-new");
    assert.equal(result.branch, "eng-1-fix-the-thing");
    const created = invocations(sdk, "lane.create");
    assert.equal(created[0].branchName, "eng-1-fix-the-thing");
    assert.equal(created[0].baseBranch, "main");
  });

  it("lets the page override the branch, and links the issue to the branch that exists", async () => {
    const { actions, sdk } = makeDeps();
    const result = await actions.pageCreateLane({
      issueId: "issue-1",
      name: "Spike",
      branchName: "spike/eng-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.branch, "spike/eng-1");
    assert.equal(result.laneName, "Spike");
    const created = invocations(sdk, "lane.create");
    assert.deepEqual([created[0].name, created[0].branchName], ["Spike", "spike/eng-1"]);
    // The ref Linear reads back must name the branch somebody actually cut.
    const linked = sdk.calls.find((entry) => entry[0] === "lanes.linkIssue");
    assert.equal(linked[1].issue.branchName, "spike/eng-1");
    assert.equal(linked[1].issue.pluginId, undefined);
  });

  it("refuses a lane for an issue Linear does not have", async () => {
    const { actions } = makeDeps({ issue: null });
    const result = await actions.pageCreateLane({ issueId: "NOPE-9" });
    assert.deepEqual(result, { ok: false, message: "That issue is not in this project's Linear view." });
  });

  it("deletes a lane, and reports a refusal as a message", async () => {
    const { actions, sdk, refreshed } = makeDeps();
    assert.deepEqual(await actions.pageDeleteLane({ laneId: "lane-1", deleteBranch: true, force: true }), {
      ok: true,
      message: "Lane deleted.",
      laneId: "lane-1",
    });
    assert.deepEqual(invocations(sdk, "lane.delete"), [{ laneId: "lane-1", deleteBranch: true, force: true }]);
    // The `hasLane` badge on every issue that lane carried is now wrong.
    assert.deepEqual(refreshed, ["issues"]);

    const refused = makeDeps({ deleteLaneThrows: new Error("The lane has uncommitted work.") });
    assert.deepEqual(await refused.actions.pageDeleteLane({ laneId: "lane-1" }), {
      ok: false,
      message: "The lane has uncommitted work.",
    });
    assert.equal((await refused.actions.pageDeleteLane({})).ok, false);
  });

  it("creates the lane, links the issue and starts the agent in one press", async () => {
    const { actions, sdk } = makeDeps();
    const result = await actions.pageLaunchAgent({
      issueId: "issue-1",
      provider: "codex",
      model: "codex/gpt-5.6",
      permissionMode: "full-auto",
      // The form's sentinel, which no provider knows: it must reach the launch
      // as the ABSENCE of the field.
      reasoningEffort: "default",
      prompt: "Pick this up.",
    });
    assert.equal(result.ok, true);
    assert.equal(result.laneId, "lane-new");
    assert.equal(result.sessionId, "session-1");
    const session = invocations(sdk, "chat.createSession")[0];
    assert.equal(session.laneId, "lane-new");
    assert.equal(session.provider, "codex");
    assert.equal(session.initialMessage, "Pick this up.");
    assert.equal("reasoningEffort" in session, false);
    // The lane link AND the session link — the second is what the chat header
    // and the PR body read.
    const links = sdk.calls.filter((entry) => entry[0] === "lanes.linkIssue").map((entry) => entry[1]);
    assert.equal(links.length, 2);
    assert.equal(links[1].sessionId, "session-1");
  });

  it("attaches the issue to a lane the page named, and launches into it", async () => {
    const { actions, sdk } = makeDeps({
      lanes: [{ id: "lane-7", name: "Existing", branchRef: "existing", issueLinks: [] }],
    });
    const result = await actions.pageLaunchCli({ issueId: "issue-1", laneId: "lane-7" });
    assert.equal(result.ok, true);
    assert.equal(result.laneId, "lane-7");
    assert.equal(result.laneName, "Existing");
    assert.equal(result.sessionId, "session-cli");
    // No second lane: naming one must never make another.
    assert.deepEqual(invocations(sdk, "lane.create"), []);
    assert.equal(invocations(sdk, "chat.launchCli").length, 1);
  });

  it("says the lane exists when only the agent failed", async () => {
    const { actions } = makeDeps({
      actions: { "chat.createSession": async () => { throw new Error("no provider configured"); } },
    });
    const result = await actions.pageLaunchAgent({ issueId: "issue-1" });
    assert.equal(result.ok, false);
    assert.match(result.message, /Opened the lane, but could not start the agent/);
    // Named, so the reader is not left looking for work that has a branch.
    assert.equal(result.laneId, "lane-new");
  });

  it("opens a chat on the issue with the reader's prompt and no model choices", async () => {
    const { actions, sdk } = makeDeps();
    const result = await actions.pageOpenChat({ issueId: "issue-1", prompt: "What is left here?" });
    assert.equal(result.ok, true);
    const session = invocations(sdk, "chat.createSession")[0];
    assert.equal(session.initialMessage, "What is left here?");
    assert.equal("provider" in session, false);
    assert.equal("model" in session, false);
  });

  it("links and unlinks an issue on a lane", async () => {
    const { actions, sdk } = makeDeps();
    const linked = await actions.pageLinkIssue({ issueId: "issue-1", laneId: "lane-3" });
    assert.equal(linked.ok, true);
    assert.equal(sdk.calls.filter((entry) => entry[0] === "lanes.linkIssue").length, 1);

    const unlinked = await actions.pageUnlinkIssue({ issueId: "issue-1", laneId: "lane-3" });
    assert.deepEqual(unlinked, {
      ok: true,
      removed: true,
      message: "Detached the issue.",
      laneId: "lane-3",
    });

    assert.equal((await actions.pageLinkIssue({ issueId: "issue-1" })).ok, false);
    assert.equal((await actions.pageUnlinkIssue({ laneId: "lane-3" })).ok, false);
  });

  it("reports a link ADE refused", async () => {
    const { actions, sdk } = makeDeps();
    sdk.lanes.linkIssue = async () => { throw new Error("link refused"); };
    const result = await actions.pageLinkIssue({ issueId: "issue-1", laneId: "lane-3" });
    assert.equal(result.ok, false);
    // The host's own sentence, which is what `flows.linkIssueToLane` reports.
    assert.match(result.message, /link refused/);
  });
});

describe("nothing a page handler answers carries a credential", () => {
  /** Field names that would be a credential if they held a string. */
  const CREDENTIAL_KEYS = new Set([
    "token", "accesstoken", "refreshtoken", "apikey", "secret", "clientsecret",
    "password", "authorization", "credential", "verifier", "codeverifier",
  ]);

  /** Values that ARE a credential in this test's world. */
  const NEEDLES = [FAKE_TOKEN, "whsec_abcdef123456", "lin_api_", "Bearer "];

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
    const { actions, data } = makeDeps();
    await data.refreshCatalog(null);
    await data.refreshIssues();

    const calls = [
      ["pageQuickView", {}],
      ["pageCatalog", {}],
      ["pageSearchIssues", { query: "oauth" }],
      ["pageIssueComments", { issueId: "issue-1" }],
      ["pageIssueById", { issueId: "issue-1" }],
      ["pageConnection", {}],
      ["pageProjects", {}],
      ["pageAutolinks", {}],
      ["pageLanes", {}],
      ["pageModels", {}],
      ["pageCapabilities", {}],
      ["pageSetIssueState", { issueId: "issue-1", stateId: "state-done" }],
      ["pageSetIssuePriority", { issueId: "issue-1", priority: 1 }],
      ["pageAssignIssue", { issueId: "issue-1", assigneeId: null }],
      ["pageAddComment", { issueId: "issue-1", body: "Shipped." }],
      ["pageAddLabel", { issueId: "issue-1", labelName: "bug" }],
      ["pageConnectOAuth", { origin: "settings" }],
      ["pageCreateAutolink", { teamKey: "ENG" }],
      ["pageCreateLane", { issueId: "issue-1" }],
      ["pageLinkIssue", { issueId: "issue-1", laneId: "lane-3" }],
      ["pageUnlinkIssue", { issueId: "issue-1", laneId: "lane-3" }],
      ["pageLaunchAgent", { issueId: "issue-1" }],
      ["pageLaunchCli", { issueId: "issue-1", laneId: "lane-new" }],
      ["pageOpenChat", { issueId: "issue-1", prompt: "hi" }],
      ["pageDeleteLane", { laneId: "lane-1" }],
      // Last, because it takes the credential away from everything above.
      ["pageSaveApiKey", { token: FAKE_TOKEN }],
      ["pageDisconnect", {}],
    ];

    const found = [];
    for (const [id, args] of calls) {
      assert.equal(typeof actions[id], "function", `${id} is missing from the page table`);
      const result = await actions[id](args);
      sweep(result, id, found);
    }
    assert.deepEqual(found, [], found.join("; "));
    // Every id the contract names was exercised above; a new one is a new case.
    assert.equal(calls.length, Object.keys(actions).length, "a page action has no secret-sweep case");
  });
});

describe("the shared shaping helpers", () => {
  it("slugifies a project name the same way on both sides of a comparison", () => {
    assert.equal(slugify("Platform & Tooling"), "platform-tooling");
    assert.equal(slugify("  "), "");
  });

  it("answers null for a row that is not one", () => {
    assert.equal(pageIssue(null), null);
    assert.equal(pageIssue("issue-1"), null);
  });
});
