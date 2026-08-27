"use strict";

/** `hn.js` — the pure half: URLs, row shape, and the feed fetch. */

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  STORY_LIMIT,
  browserUrl,
  commentsUrl,
  fetchFeed,
  isFeed,
  parseFeed,
  storyKey,
  storyRow,
} = require("../hn");

function item(over = {}) {
  return { id: 42, type: "story", title: "A title", by: "pg", score: 120, descendants: 7, ...over };
}

describe("parseFeed", () => {
  it("takes the three real feeds and falls back on everything else", () => {
    for (const feed of ["top", "new", "ask"]) {
      assert.equal(isFeed(feed), true);
      assert.equal(parseFeed(feed, "top"), feed);
    }
    assert.equal(parseFeed("show", "ask"), "ask");
    assert.equal(parseFeed(undefined, "new"), "new");
    assert.equal(parseFeed(7, "top"), "top");
    // The empty fallback is how `feedFromArgs` asks "was a feed named at all".
    assert.equal(parseFeed("nonsense", ""), "");
  });
});

describe("browserUrl", () => {
  it("keeps an https link as it stands", () => {
    assert.equal(browserUrl(item({ url: "https://example.com/a" })), "https://example.com/a");
  });

  it("upgrades an http link, because openUrl refuses http", () => {
    // `{openUrl}` is https-only: http, file, data, javascript and ade are all
    // refused by the host reader, so an un-upgraded link would open nothing.
    assert.equal(browserUrl(item({ url: "http://example.com/a" })), "https://example.com/a");
  });

  it("falls back to the discussion page when there is no link at all", () => {
    // Ask HN and Show HN posts are self-posts: they carry no `url`.
    assert.equal(browserUrl(item({ id: 9, url: undefined })), "https://news.ycombinator.com/item?id=9");
    assert.equal(browserUrl(item({ id: 9, url: "javascript:alert(1)" })), "https://news.ycombinator.com/item?id=9");
    // A story with no usable id cannot address a discussion page either, so the
    // last resort is the front page. (`storyRow` never reaches this: `fetchFeed`
    // drops an item whose `id` is null before a row is ever built.)
    assert.equal(browserUrl({ id: "not-a-number" }), "https://news.ycombinator.com/");
  });

  it("refuses a link past the 2,048-character openUrl ceiling", () => {
    const long = `https://example.com/${"x".repeat(2100)}`;
    assert.equal(browserUrl(item({ id: 5, url: long })), "https://news.ycombinator.com/item?id=5");
  });
});

describe("storyRow", () => {
  it("renders points and comments the reader asked to see", () => {
    const row = storyRow(item(), 0, new Set());
    assert.equal(row.value.subtitle, "120 points · 7 comments");
    assert.equal(row.value.meta, "pg");
    assert.equal(row.value.title, "A title");
  });

  it("counts a missing score or comment count as zero, never NaN", () => {
    const row = storyRow(item({ score: undefined, descendants: undefined }), 0, new Set());
    assert.equal(row.value.subtitle, "0 points · 0 comments");
  });

  it("carries the row's own actions, and only ones the panel allows", () => {
    const unread = storyRow(item(), 0, new Set());
    assert.deepEqual(unread.value.onPress, { action: "openStory", args: { id: "42" } });
    assert.deepEqual(unread.value.actions.map((a) => a.action), ["markRead"]);
    assert.deepEqual(unread.value.overflow.map((a) => a.action), ["openComments"]);
  });

  it("flips tone, badge and the trailing button once a story is read", () => {
    const read = storyRow(item(), 0, new Set(["42"]));
    assert.equal(read.value.readFlag, "read");
    assert.equal(read.value.tone, "neutral");
    assert.deepEqual(read.value.badge, { text: "Read", tone: "neutral" });
    assert.deepEqual(read.value.actions.map((a) => a.action), ["markUnread"]);

    const unread = storyRow(item(), 0, new Set());
    assert.equal(unread.value.readFlag, "unread");
    assert.equal(unread.value.tone, "accent");
    assert.equal(unread.value.badge, undefined);
  });

  it("keys rows in feed order so they sort the way HN ranked them", () => {
    // `collections.list` returns rows ordered by key, so the padding is what
    // keeps story 10 after story 9 instead of after story 1.
    assert.equal(storyKey(0), "s:000");
    assert.equal(storyKey(9), "s:009");
    assert.equal(storyKey(10), "s:010");
    assert.ok(storyKey(9) < storyKey(10));
  });
});

describe("fetchFeed", () => {
  function stubFetch(ids, overrides = {}) {
    const seen = [];
    return {
      seen,
      impl: async (url) => {
        seen.push(url);
        if (url.endsWith("stories.json")) return ids;
        const id = Number(url.match(/item\/(\d+)\.json/)[1]);
        return { id, type: "story", title: `Story ${id}`, by: "pg", score: id, descendants: 1, ...(overrides[id] ?? {}) };
      },
    };
  }

  it("asks the right list for each feed", async () => {
    for (const [feed, file] of [["top", "topstories"], ["new", "newstories"], ["ask", "askstories"]]) {
      const stub = stubFetch([1]);
      await fetchFeed(feed, async () => new Set(), stub.impl);
      assert.ok(stub.seen[0].endsWith(`/${file}.json`), `${feed} asked for ${stub.seen[0]}`);
    }
  });

  it("never materializes more than STORY_LIMIT stories", async () => {
    const stub = stubFetch(Array.from({ length: 200 }, (_, i) => i + 1));
    const rows = await fetchFeed("top", async () => new Set(), stub.impl);
    assert.equal(rows.length, STORY_LIMIT);
  });

  it("resolves the read set from the ids it actually kept, not the whole store", async () => {
    // The regression this pins: reading the whole `read` collection needs a row
    // limit, and `collections.list` silently clamps one to 1,000 — so a reader
    // past a thousand marked stories saw the oldest of them turn unread again.
    // Asking by id has no ceiling, so this is also the shape assertion.
    const stub = stubFetch([1, 2, 3]);
    let asked = null;
    const rows = await fetchFeed("top", async (ids) => {
      asked = ids;
      return new Set(["2"]);
    }, stub.impl);
    assert.deepEqual(asked, ["1", "2", "3"]);
    assert.deepEqual(rows.map((r) => r.value.readFlag), ["unread", "read", "unread"]);
  });

  it("drops job posts and keeps the row keys contiguous", async () => {
    const stub = stubFetch([1, 2, 3], { 2: { type: "job" } });
    const rows = await fetchFeed("top", async () => new Set(), stub.impl);
    assert.deepEqual(rows.map((r) => r.key), ["s:000", "s:001"]);
    assert.deepEqual(rows.map((r) => r.value.id), ["1", "3"]);
  });

  it("loses one unreachable story, never the feed", async () => {
    const stub = stubFetch([1, 2, 3]);
    const impl = async (url) => {
      if (url.includes("item/2.json")) throw new Error("network");
      return stub.impl(url);
    };
    const rows = await fetchFeed("top", async () => new Set(), impl);
    assert.deepEqual(rows.map((r) => r.value.id), ["1", "3"]);
  });

  it("answers empty when HN does not return a list", async () => {
    const rows = await fetchFeed("top", async () => new Set(), async () => ({ error: "nope" }));
    assert.deepEqual(rows, []);
  });

  it("only ever contacts the declared host", async () => {
    const stub = stubFetch([1, 2]);
    await fetchFeed("top", async () => new Set(), stub.impl);
    for (const url of stub.seen) {
      assert.equal(new URL(url).host, "hacker-news.firebaseio.com", `${url} is not the declared host`);
    }
  });
});

describe("commentsUrl", () => {
  it("addresses the HN discussion page", () => {
    assert.equal(commentsUrl("123"), "https://news.ycombinator.com/item?id=123");
  });
});
