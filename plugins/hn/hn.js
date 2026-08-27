"use strict";

/** Feeds the header dropdown and the panel control both name. */
const FEEDS = ["top", "new", "ask"];

const HN_API = "https://hacker-news.firebaseio.com/v0";
const HN_ITEM = "https://news.ycombinator.com/item?id=";

/** How many stories one feed materializes. Bound the cache, not HN. */
const STORY_LIMIT = 30;
/** Parallel item reads. HN is one GET per story. */
const ITEM_CONCURRENCY = 6;

function isFeed(value) {
  return FEEDS.includes(value);
}

function parseFeed(value, fallback = "top") {
  if (typeof value === "string" && isFeed(value)) return value;
  return fallback;
}

const LIST_PATH = {
  top: "topstories.json",
  new: "newstories.json",
  ask: "askstories.json",
};

function listPath(feed) {
  return LIST_PATH[feed] ?? LIST_PATH.top;
}

/**
 * `openUrl` is https-only. HN still serves a lot of `http:` story links, so
 * those get upgraded; anything else falls through to the discussion page.
 */
function browserUrl(item) {
  const id = Number(item?.id);
  const discussion = Number.isFinite(id) ? `${HN_ITEM}${id}` : null;
  const raw = typeof item?.url === "string" ? item.url.trim() : "";
  if (raw.startsWith("https://") && raw.length <= 2048) return raw;
  if (raw.startsWith("http://")) {
    const upgraded = `https://${raw.slice("http://".length)}`;
    if (upgraded.length <= 2048) return upgraded;
  }
  return discussion ?? "https://news.ycombinator.com/";
}

function commentsUrl(id) {
  return `${HN_ITEM}${id}`;
}

function asCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function storyKey(index) {
  return `s:${String(index).padStart(3, "0")}`;
}

function storyRow(item, index, readIds) {
  const id = String(item.id);
  const points = asCount(item.score);
  const comments = asCount(item.descendants);
  const read = readIds.has(id);
  const by = typeof item.by === "string" && item.by.trim() ? item.by.trim() : "unknown";
  return {
    key: storyKey(index),
    value: {
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : `Story ${id}`,
      subtitle: `${points} points · ${comments} comments`,
      meta: by,
      tone: read ? "neutral" : "accent",
      ...(read ? { badge: { text: "Read", tone: "neutral" } } : {}),
      onPress: { action: "openStory", args: { id } },
      actions: read
        ? [{ action: "markUnread", label: "Unread", args: { id } }]
        : [{ action: "markRead", label: "Mark read", args: { id } }],
      overflow: [{ action: "openComments", label: "Comments", args: { id } }],
      readFlag: read ? "read" : "unread",
      id,
      url: browserUrl(item),
      commentsUrl: commentsUrl(id),
    },
  };
}

async function mapPool(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await mapper(items[index], index);
    }
  }
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HN ${response.status} for ${url}`);
  }
  return response.json();
}

/**
 * One feed, as rows.
 *
 * `resolveRead` is asked for the read set only AFTER the story ids are known,
 * and is handed exactly those ids. Reading the whole `read` collection instead
 * would have to name a row limit, and `collections.list` silently clamps one to
 * 1,000 — so a reader who has marked more than a thousand stories would start
 * seeing the oldest of them as unread again. Asking by id has no such ceiling.
 */
async function fetchFeed(feed, resolveRead, fetchImpl = fetchJson) {
  const ids = await fetchImpl(`${HN_API}/${listPath(feed)}`);
  if (!Array.isArray(ids)) return [];
  const sliced = ids.slice(0, STORY_LIMIT);
  const items = await mapPool(sliced, ITEM_CONCURRENCY, async (id) => {
    try {
      const item = await fetchImpl(`${HN_API}/item/${id}.json`);
      if (!item || typeof item !== "object" || item.id == null) return null;
      if (item.type === "job") return null;
      return item;
    } catch {
      return null;
    }
  });
  const kept = items.filter(Boolean);
  const readIds = await resolveRead(kept.map((item) => String(item.id)));
  const rows = [];
  for (const item of kept) {
    rows.push(storyRow(item, rows.length, readIds));
  }
  return rows;
}

module.exports = {
  FEEDS,
  STORY_LIMIT,
  browserUrl,
  commentsUrl,
  fetchFeed,
  isFeed,
  parseFeed,
  storyKey,
  storyRow,
};
