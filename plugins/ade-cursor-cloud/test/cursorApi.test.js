"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  CursorApiError,
  createCursorApi,
  errorForResponse,
  isMissingKeyError,
} = require("../cursorApi");
const { CURSOR_MAX_PAGE_LIMIT, clampPageLimit, clampFleetBudget, repoMatchKey, repoLabel } = require("../repoMatch");

/** A `fetch` that answers from a script and records what it was asked. */
function fakeFetch(pages) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const page = pages[Math.min(index++, pages.length - 1)];
      if (typeof page === "function") return page(url, init);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page),
      };
    },
  };
}

describe("the Cursor page ceiling", () => {
  it("never asks for more than 100 in one page", () => {
    // Cursor answers `[validation_error] Limit must be at most 100`, and the
    // whole point of paging is that a caller asking for 500 still gets 500.
    assert.equal(clampPageLimit(500), CURSOR_MAX_PAGE_LIMIT);
    assert.equal(clampPageLimit(100), 100);
    assert.equal(clampPageLimit(0), 1);
    assert.equal(clampPageLimit(undefined), undefined);
    assert.equal(clampPageLimit(Number.NaN), undefined);
  });

  it("clamps a whole-read budget into the fleet ceiling", () => {
    assert.equal(clampFleetBudget(undefined), 100);
    assert.equal(clampFleetBudget(9_000), 200);
    assert.equal(clampFleetBudget(-4), 1);
  });
});

describe("listAgentsPaged", () => {
  it("follows nextCursor until the budget is filled", async () => {
    const { fetch, calls } = fakeFetch([
      { items: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })), nextCursor: "c1" },
      { items: Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` })), nextCursor: "c2" },
    ]);
    const api = createCursorApi({ getApiKey: async () => "key", fetch });

    const items = await api.listAgentsPaged({ budget: 150 });

    assert.equal(items.length, 150);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /limit=100/);
    assert.doesNotMatch(calls[0].url, /cursor=/);
    // The second page asks for exactly the remainder, never a full page it
    // would then throw half of away.
    assert.match(calls[1].url, /limit=50/);
    assert.match(calls[1].url, /cursor=c1/);
  });

  it("stops when a page comes back without a next cursor", async () => {
    const { fetch, calls } = fakeFetch([{ items: [{ id: "a" }, { id: "b" }] }]);
    const api = createCursorApi({ getApiKey: async () => "key", fetch });

    assert.equal((await api.listAgentsPaged({ budget: 200 })).length, 2);
    assert.equal(calls.length, 1);
  });

  it("stops when the server repeats a cursor rather than paging forever", async () => {
    // A server that answers the same cursor twice would otherwise be an
    // infinite loop inside one action, which the host would only see as a
    // timeout with nothing to explain it.
    const { fetch, calls } = fakeFetch([{ items: [{ id: "a" }], nextCursor: "same" }]);
    const api = createCursorApi({ getApiKey: async () => "key", fetch });

    await api.listAgentsPaged({ budget: 200 });

    assert.equal(calls.length, 2);
  });

  it("asks for archived agents too, so a count can be shown", async () => {
    const { fetch, calls } = fakeFetch([{ items: [] }]);
    const api = createCursorApi({ getApiKey: async () => "key", fetch });
    await api.listAgentsPaged({ budget: 10 });
    assert.match(calls[0].url, /includeArchived=true/);
  });
});

describe("the key", () => {
  it("refuses with `no_key` rather than calling Cursor without one", async () => {
    const { fetch, calls } = fakeFetch([{ items: [] }]);
    const api = createCursorApi({ getApiKey: async () => null, fetch });

    await assert.rejects(() => api.listAgents(), (error) => {
      assert.ok(isMissingKeyError(error));
      return true;
    });
    assert.equal(calls.length, 0, "no request may be made without a key");
  });

  it("treats whitespace as no key at all", async () => {
    const api = createCursorApi({ getApiKey: async () => "   ", fetch: async () => { throw new Error("called"); } });
    assert.equal(await api.hasKey(), false);
  });

  it("sends the key as a bearer token and never in the URL", async () => {
    const { fetch, calls } = fakeFetch([{ items: [] }]);
    const api = createCursorApi({ getApiKey: async () => "secret-key", fetch });
    await api.listAgents();
    assert.equal(calls[0].headers.Authorization, "Bearer secret-key");
    assert.doesNotMatch(calls[0].url, /secret-key/);
  });
});

describe("errors a panel can branch on", () => {
  it("maps each status to its own code", () => {
    assert.equal(errorForResponse(401, "").code, "unauthorized");
    assert.equal(errorForResponse(403, "").code, "unauthorized");
    assert.equal(errorForResponse(404, "").code, "not_found");
    assert.equal(errorForResponse(429, "").code, "rate_limited");
    assert.equal(errorForResponse(422, "").code, "validation");
    assert.equal(errorForResponse(500, "").code, "http");
  });

  it("prefers Cursor's own sentence over the status line", () => {
    const error = errorForResponse(400, JSON.stringify({ error: { message: "Limit must be at most 100" } }));
    assert.match(error.message, /Limit must be at most 100/);
  });

  it("is an Error, so a handler that only logs `.message` still says something", () => {
    assert.ok(errorForResponse(500, "") instanceof CursorApiError);
    assert.ok(errorForResponse(500, "") instanceof Error);
  });
});

describe("repo matching", () => {
  it("treats every spelling of one repository as the same repository", () => {
    const wanted = repoMatchKey("https://github.com/owner/repo");
    assert.equal(repoMatchKey("git@github.com:owner/repo.git"), wanted);
    assert.equal(repoMatchKey("https://github.com/owner/repo.git"), wanted);
    assert.equal(repoMatchKey("https://user@github.com/Owner/Repo/"), wanted);
    assert.equal(repoMatchKey("ssh://git@github.com/owner/repo"), wanted);
  });

  it("has no key for nothing", () => {
    assert.equal(repoMatchKey(null), "");
    assert.equal(repoMatchKey("   "), "");
  });

  it("labels a row with owner/repo", () => {
    assert.equal(repoLabel("git@github.com:owner/repo.git"), "owner/repo");
  });
});
