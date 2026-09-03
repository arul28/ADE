"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  authorizationHeader,
  createLinearApi,
  isMissingTokenError,
  tokenNeedsRefresh,
} = require("../linearApi");
const { createSecrets, issueNode, response } = require("./support");

const OAUTH = {
  LINEAR_ACCESS_TOKEN: "oauth-token",
  LINEAR_AUTH_MODE: "oauth",
  LINEAR_REFRESH_TOKEN: "refresh-token",
  LINEAR_OAUTH_CLIENT_ID: "client-1",
  LINEAR_TOKEN_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
};

const API_KEY = {
  LINEAR_ACCESS_TOKEN: "lin_api_abcdefghijklmnopqrstuv",
  LINEAR_AUTH_MODE: "manual",
};

/** A fetch fake that answers a queue and records every request it was given. */
function fetchQueue(answers) {
  const requests = [];
  const queue = [...answers];
  const impl = async (url, init) => {
    requests.push({ url, init, headers: init?.headers ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("fetch called more times than the test queued answers");
    if (next instanceof Error) throw next;
    return next;
  };
  impl.requests = requests;
  impl.remaining = () => queue.length;
  return impl;
}

function build(secrets, fetchImpl, overrides = {}) {
  return createLinearApi({
    secrets,
    fetch: fetchImpl,
    sleep: async () => {},
    now: overrides.now ?? (() => Date.parse("2026-08-31T00:00:00.000Z")),
    ...overrides,
  });
}

describe("the two credential kinds are not interchangeable", () => {
  it("sends an OAuth token as Bearer and an API key bare", () => {
    assert.equal(authorizationHeader("abc", "oauth"), "Bearer abc");
    assert.equal(authorizationHeader("lin_api_abc", "manual"), "lin_api_abc");
  });

  it("is idempotent on an already-prefixed OAuth token", () => {
    assert.equal(authorizationHeader("Bearer abc", "oauth"), "Bearer abc");
  });

  it("strips a prefix a user pasted in front of an API key", () => {
    // Sending `Bearer lin_api_…` is a 400 about the header, not a 401, so a
    // client that passed it through would report "Linear refused this token"
    // for a token that is fine.
    assert.equal(authorizationHeader("Bearer lin_api_abc", "manual"), "lin_api_abc");
  });

  it("refuses to guess for a credential whose kind is unknown", () => {
    assert.throws(() => authorizationHeader("abc", null), /does not say whether/);
    assert.throws(() => authorizationHeader("abc", "something-else"), /does not say whether/);
  });

  it("refuses an empty credential as no_token, not as a bad one", () => {
    assert.throws(() => authorizationHeader("   ", "oauth"), (error) => isMissingTokenError(error));
  });

  it("sends the right header shape for each stored mode", async () => {
    const oauthFetch = fetchQueue([response(200, { data: { issue: null } })]);
    await build(createSecrets(OAUTH), oauthFetch).fetchIssueById("x");
    assert.equal(oauthFetch.requests[0].headers.authorization, "Bearer oauth-token");

    const keyFetch = fetchQueue([response(200, { data: { issue: null } })]);
    await build(createSecrets(API_KEY), keyFetch).fetchIssueById("x");
    assert.equal(keyFetch.requests[0].headers.authorization, API_KEY.LINEAR_ACCESS_TOKEN);
  });
});

describe("when a token needs refreshing", () => {
  const at = Date.parse("2026-08-31T12:00:00.000Z");

  it("says no for a token that does not expire", () => {
    assert.equal(tokenNeedsRefresh(null, at), false);
  });

  it("says no while the token has more than the buffer left", () => {
    assert.equal(tokenNeedsRefresh("2026-08-31T12:10:00.000Z", at), false);
  });

  it("says yes INSIDE the buffer, before the token actually expires", () => {
    // Two minutes, matching the built-in: long enough to cover a slow request
    // that started just under the wire.
    assert.equal(tokenNeedsRefresh("2026-08-31T12:01:00.000Z", at), true);
  });

  it("says no for an expiry it cannot parse, rather than refreshing forever", () => {
    assert.equal(tokenNeedsRefresh("not a date", at), false);
  });
});

describe("running one GraphQL operation", () => {
  it("returns the data and never the envelope", async () => {
    const impl = fetchQueue([response(200, { data: { issue: issueNode() } })]);
    const result = await build(createSecrets(API_KEY), impl).fetchIssueById("issue-1");
    assert.equal(result.identifier, "ENG-1");
  });

  it("posts the query and variables as JSON", async () => {
    const impl = fetchQueue([response(200, { data: { issue: null } })]);
    await build(createSecrets(API_KEY), impl).fetchIssueById("ENG-1");
    const body = JSON.parse(impl.requests[0].init.body);
    assert.match(body.query, /query IssueById/);
    assert.deepEqual(body.variables, { id: "ENG-1" });
  });

  it("retries a transport failure and then succeeds", async () => {
    const impl = fetchQueue([new Error("ECONNRESET"), response(200, { data: { issue: issueNode() } })]);
    const result = await build(createSecrets(API_KEY), impl).fetchIssueById("issue-1");
    assert.equal(result.id, "issue-1");
    assert.equal(impl.requests.length, 2);
  });

  it("gives up on a transport failure once the budget is spent", async () => {
    const impl = fetchQueue([new Error("x"), new Error("x"), new Error("x")]);
    await assert.rejects(
      () => build(createSecrets(API_KEY), impl).fetchIssueById("issue-1"),
      (error) => error.code === "network",
    );
  });

  it("retries a 500 and does NOT retry a 400", async () => {
    const server = fetchQueue([response(500, ""), response(200, { data: { issue: null } })]);
    await build(createSecrets(API_KEY), server).fetchIssueById("x");
    assert.equal(server.requests.length, 2);

    // Retrying a malformed query only spends the rate limit.
    const bad = fetchQueue([response(400, { errors: [{ message: "Field 'nope' doesn't exist" }] })]);
    await assert.rejects(
      () => build(createSecrets(API_KEY), bad).fetchIssueById("x"),
      (error) => error.code === "validation",
    );
    assert.equal(bad.requests.length, 1);
  });
});

describe("the three ways Linear says rate limited", () => {
  const cases = [
    ["an HTTP 429", response(429, "")],
    ["a RATELIMITED extension code", response(200, { errors: [{ message: "no", extensions: { code: "RATELIMITED" } }] })],
    ["a plain sentence", response(200, { errors: [{ message: "You have exceeded the rate limit" }] })],
  ];

  for (const [label, answer] of cases) {
    it(`folds ${label} into rate_limited`, async () => {
      const impl = fetchQueue([answer, answer, answer, answer]);
      await assert.rejects(
        () => build(createSecrets(API_KEY), impl).fetchIssueById("x"),
        (error) => error.code === "rate_limited",
      );
    });
  }

  it("waits the Retry-After the server named", async () => {
    const waits = [];
    const impl = fetchQueue([response(429, "", { "retry-after": "3" }), response(200, { data: { issue: null } })]);
    await createLinearApi({
      secrets: createSecrets(API_KEY),
      fetch: impl,
      sleep: async (ms) => waits.push(ms),
    }).fetchIssueById("x");
    assert.deepEqual(waits, [3_000]);
  });

  it("names a credential of unknown kind as no_token, not as a network failure", async () => {
    // The header is built BEFORE the fetch `try`. Inside it, this throw was
    // caught as a transport error: three sleeps, then `network` — so
    // `isMissingTokenError` said no and the panel drew an error banner where
    // the Connect button belonged. Reachable whenever the token secret exists
    // and the auth-mode secret does not.
    const waits = [];
    const impl = fetchQueue([]);
    const api = build(
      createSecrets({ LINEAR_ACCESS_TOKEN: "lin_api_abcdefghijklmnopqrstuv" }),
      impl,
      { sleep: async (ms) => waits.push(ms) },
    );
    const error = await api.fetchIssueById("x").then(() => null, (thrown) => thrown);
    assert.equal(error.code, "no_token");
    assert.ok(isMissingTokenError(error));
    assert.deepEqual(waits, [], "slept on a credential no retry can fix");
    assert.equal(impl.requests.length, 0, "reached Linear with a header it could not build");
  });
});

describe("refreshing an expired OAuth token", () => {
  const expired = { ...OAUTH, LINEAR_TOKEN_EXPIRES_AT: "2026-08-30T00:00:00.000Z" };

  it("refreshes ahead of the request, and stores the new token", async () => {
    const secrets = createSecrets(expired);
    const impl = fetchQueue([
      response(200, { access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 }),
      response(200, { data: { issue: null } }),
    ]);
    await build(secrets, impl).fetchIssueById("x");

    assert.match(impl.requests[0].url, /oauth\/token$/);
    assert.equal(await secrets.get("LINEAR_ACCESS_TOKEN"), "new-token");
    assert.equal(await secrets.get("LINEAR_REFRESH_TOKEN"), "new-refresh");
    assert.equal(impl.requests[1].headers.authorization, "Bearer new-token");
  });

  it("sends client_id and NO client_secret, because ADE never lends one", async () => {
    const impl = fetchQueue([
      response(200, { access_token: "t", expires_in: 60 }),
      response(200, { data: { issue: null } }),
    ]);
    await build(createSecrets(expired), impl).fetchIssueById("x");
    const body = new URLSearchParams(impl.requests[0].init.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("client_id"), "client-1");
    assert.equal(body.get("client_secret"), null);
  });

  it("keeps the old refresh token when Linear did not send a new one", async () => {
    const secrets = createSecrets(expired);
    const impl = fetchQueue([
      response(200, { access_token: "t", expires_in: 60 }),
      response(200, { data: { issue: null } }),
    ]);
    await build(secrets, impl).fetchIssueById("x");
    assert.equal(await secrets.get("LINEAR_REFRESH_TOKEN"), "refresh-token");
  });

  it("does NOT fail the read when a proactive refresh fails", async () => {
    // The stored token may still have minutes left; failing here would turn a
    // slow refresh endpoint into an outage.
    const impl = fetchQueue([response(500, ""), response(200, { data: { issue: issueNode() } })]);
    const result = await build(createSecrets(expired), impl).fetchIssueById("issue-1");
    assert.equal(result.id, "issue-1");
    assert.equal(impl.requests[1].headers.authorization, "Bearer oauth-token");
  });

  it("DOES fail when Linear says invalid_grant, because that means reconnect", async () => {
    const impl = fetchQueue([response(400, { error: "invalid_grant" })]);
    await assert.rejects(
      () => build(createSecrets(expired), impl).fetchIssueById("x"),
      (error) => error.code === "unauthorized" && error.invalidGrant === true,
    );
  });

  it("tries the stale token when there is no refresh token, and only THEN says reconnect", async () => {
    // The proactive path is non-fatal by design, so a connection with no
    // refresh token still sends what it has — the token may be seconds from
    // expiry rather than past it. Linear's 401 is what turns it into the
    // message that actually helps.
    const secrets = createSecrets({ ...expired, LINEAR_REFRESH_TOKEN: "" });
    const impl = fetchQueue([response(401, "")]);
    await assert.rejects(
      () => build(secrets, impl).fetchIssueById("x"),
      (error) => error.code === "unauthorized" && /Connect Linear again/.test(error.message),
    );
    assert.equal(impl.requests[0].headers.authorization, "Bearer oauth-token");
  });

  it("refreshes ONCE for a burst, not once per caller", async () => {
    const secrets = createSecrets(expired);
    const impl = fetchQueue([
      response(200, { access_token: "t", expires_in: 3600 }),
      response(200, { data: { issue: null } }),
      response(200, { data: { issue: null } }),
      response(200, { data: { issue: null } }),
    ]);
    const api = build(secrets, impl);
    await Promise.all([api.fetchIssueById("a"), api.fetchIssueById("b"), api.fetchIssueById("c")]);
    // One token call, three GraphQL calls. Two token calls would spend the
    // refresh token twice, and Linear may rotate it.
    assert.equal(impl.requests.filter((entry) => /oauth\/token$/.test(entry.url)).length, 1);
  });
});

describe("a 401 mid-flight", () => {
  it("refreshes once and replays the request", async () => {
    const impl = fetchQueue([
      response(401, { errors: [{ message: "Authentication required" }] }),
      response(200, { access_token: "fresh", expires_in: 3600 }),
      response(200, { data: { issue: issueNode() } }),
    ]);
    const result = await build(createSecrets(OAUTH), impl).fetchIssueById("issue-1");
    assert.equal(result.id, "issue-1");
    assert.equal(impl.requests[2].headers.authorization, "Bearer fresh");
  });

  it("fails on the SECOND 401 rather than looping", async () => {
    const impl = fetchQueue([
      response(401, ""),
      response(200, { access_token: "fresh", expires_in: 3600 }),
      response(401, ""),
    ]);
    await assert.rejects(
      () => build(createSecrets(OAUTH), impl).fetchIssueById("x"),
      (error) => error.code === "unauthorized",
    );
  });

  it("does not try to refresh an API key", async () => {
    const impl = fetchQueue([response(401, "")]);
    await assert.rejects(
      () => build(createSecrets(API_KEY), impl).fetchIssueById("x"),
      (error) => error.code === "unauthorized",
    );
    assert.equal(impl.requests.length, 1);
  });

  it("reports no_token when nothing is stored at all", async () => {
    await assert.rejects(
      () => build(createSecrets({}), fetchQueue([])).fetchIssueById("x"),
      (error) => isMissingTokenError(error),
    );
  });
});

describe("paging and filters", () => {
  it("walks pages until the ceiling the caller named", async () => {
    const page = (ids, hasNext) => response(200, {
      data: {
        issues: {
          pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? "cursor" : null },
          nodes: ids.map((id) => issueNode({ id })),
        },
      },
    });
    const impl = fetchQueue([page(["a", "b"], true), page(["c"], false)]);
    const nodes = await build(createSecrets(API_KEY), impl).searchAllIssues({}, 10);
    assert.deepEqual(nodes.map((node) => node.id), ["a", "b", "c"]);
  });

  it("stops at the ceiling even when Linear has more", async () => {
    const impl = fetchQueue([response(200, {
      data: { issues: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [issueNode({ id: "a" })] } },
    })]);
    const nodes = await build(createSecrets(API_KEY), impl).searchAllIssues({}, 1);
    assert.equal(nodes.length, 1);
    assert.equal(impl.remaining(), 0);
  });

  it("matches an issue KEY by its trailing number", async () => {
    // Linear's IssueFilter has no `identifier` field, so a reader typing
    // `ADE-14` cannot be matched on the identifier at all. Without the number
    // clause, typing an issue key would never find that issue.
    const impl = fetchQueue([response(200, { data: { issues: { pageInfo: {}, nodes: [] } } })]);
    await build(createSecrets(API_KEY), impl).searchIssues({ query: "ADE-14" });
    const filter = JSON.parse(impl.requests[0].init.body).variables.filter;
    assert.ok(filter.or.some((clause) => clause.number?.eq === 14));
  });

  it("sends no filter at all when nothing was asked for", async () => {
    const impl = fetchQueue([response(200, { data: { issues: { pageInfo: {}, nodes: [] } } })]);
    await build(createSecrets(API_KEY), impl).searchIssues({});
    assert.equal(JSON.parse(impl.requests[0].init.body).variables.filter, null);
  });

  it("clamps `first` to Linear's own ceiling of 100", async () => {
    const impl = fetchQueue([response(200, { data: { issues: { pageInfo: {}, nodes: [] } } })]);
    await build(createSecrets(API_KEY), impl).searchIssues({ first: 5_000 });
    assert.equal(JSON.parse(impl.requests[0].init.body).variables.first, 100);
  });

  it("drops a priority outside Linear's 0..4 scale rather than sending it", async () => {
    const impl = fetchQueue([response(200, { data: { issues: { pageInfo: {}, nodes: [] } } })]);
    await build(createSecrets(API_KEY), impl).searchIssues({ priority: 9 });
    assert.equal(JSON.parse(impl.requests[0].init.body).variables.filter, null);
  });
});

describe("adding a label by name", () => {
  it("resolves the name to an id, then sends the id", async () => {
    const impl = fetchQueue([
      response(200, { data: { issueLabels: { nodes: [{ id: "l1", name: "Bug", team: null }] } } }),
      response(200, { data: { issueUpdate: { success: true } } }),
    ]);
    const id = await build(createSecrets(API_KEY), impl).addLabel("issue-1", "bug");
    assert.equal(id, "l1");
    assert.deepEqual(JSON.parse(impl.requests[1].init.body).variables.labelIds, ["l1"]);
  });

  it("refuses a label that does not exist instead of silently doing nothing", async () => {
    // "I added it" for a label that does not exist is the failure an agent
    // would report to the user as success.
    const impl = fetchQueue([response(200, { data: { issueLabels: { nodes: [] } } })]);
    await assert.rejects(
      () => build(createSecrets(API_KEY), impl).addLabel("issue-1", "nope"),
      (error) => error.code === "validation" && /no label called "nope"/.test(error.message),
    );
  });

  it("refuses an empty label name before spending a request", async () => {
    const impl = fetchQueue([]);
    await assert.rejects(() => build(createSecrets(API_KEY), impl).addLabel("issue-1", "  "));
    assert.equal(impl.requests.length, 0);
  });
});
