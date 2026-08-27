"use strict";

const { commentsUrl, fetchFeed, parseFeed } = require("./hn");

const ROW_ACTIONS = ["openStory", "markRead", "markUnread", "openComments"];

let sdk = null;
let lastFeed = "top";

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
}

async function put(collection, key, value, options) {
  try {
    await sdk.collections.put(collection, key, value, options);
  } catch (error) {
    if (errorCode(error) !== "plugin_budget_exceeded") throw error;
    log("warn", `Skipped ${collection}:${key}: store full.`);
  }
}

async function readIds() {
  const rows = await sdk.collections.list("read", { limit: 4000 });
  const ids = new Set();
  for (const row of rows) ids.add(row.key);
  return ids;
}

async function replaceStories(rows) {
  const existing = await sdk.collections.list("stories", { limit: 500 });
  const keep = new Set(rows.map((row) => row.key));
  for (const row of rows) {
    await put("stories", row.key, row.value, { ifFull: "evictOldest" });
  }
  for (const stored of existing) {
    if (!keep.has(stored.key)) await sdk.collections.delete("stories", stored.key);
  }
}

function storiesPanel(feed) {
  return {
    v: 1,
    title: "Hacker News",
    fallback: {
      title: "Hacker News",
      text: "Open ADE on a machine that has this plugin installed to read stories.",
      deeplink: "ade://plugin/hn/stories",
    },
    body: [
      {
        component: "stack",
        direction: "vertical",
        gap: "md",
        children: [
          { component: "text", text: "Hacker News", variant: "title" },
          {
            component: "stack",
            direction: "horizontal",
            gap: "md",
            wrap: true,
            children: [
              {
                component: "segmented",
                stateKey: "feed",
                label: "Feed",
                default: feed,
                options: [
                  { value: "top", label: "Top" },
                  { value: "new", label: "New" },
                  { value: "ask", label: "Ask" },
                ],
                onChange: { action: "selectFeed" },
              },
              {
                component: "segmented",
                stateKey: "show",
                label: "Show",
                default: "",
                options: [
                  { value: "", label: "All" },
                  { value: "unread", label: "Unread" },
                ],
              },
            ],
          },
          {
            component: "list",
            bind: {
              collection: "stories",
              limit: 100,
              allowActions: ROW_ACTIONS,
              where: [{ field: "readFlag", equals: { $state: "show" } }],
            },
            emptyText: "No stories in this feed.",
          },
        ],
      },
    ],
  };
}

async function publishPanel(feed) {
  await sdk.panels.update("stories", storiesPanel(feed));
}

async function loadFeed(feed) {
  lastFeed = feed;
  await put("prefs", "feed", { feed }, { ifFull: "evictOldest" });
  const rows = await fetchFeed(feed, await readIds());
  await replaceStories(rows);
  await publishPanel(feed);
  return rows.length;
}

function feedFromArgs(args) {
  const named = parseFeed(args?.feed, "");
  if (named) return named;
  const state = args?.state;
  if (state && typeof state === "object") return parseFeed(state.feed, lastFeed);
  return lastFeed;
}

async function findStory(id) {
  const rows = await sdk.collections.list("stories", { limit: 100 });
  return rows.find((row) => row.value && String(row.value.id) === String(id)) ?? null;
}

async function rewriteStory(id, read) {
  const stored = await findStory(id);
  if (!stored || !stored.value) return;
  const value = { ...stored.value };
  if (read) {
    value.tone = "neutral";
    value.badge = { text: "Read", tone: "neutral" };
    value.readFlag = "read";
    value.actions = [{ action: "markUnread", label: "Unread", args: { id: String(id) } }];
  } else {
    value.tone = "accent";
    delete value.badge;
    value.readFlag = "unread";
    value.actions = [{ action: "markRead", label: "Mark read", args: { id: String(id) } }];
  }
  await put("stories", stored.key, value, { ifFull: "evictOldest" });
}

async function markRead(id) {
  const key = String(id);
  const stored = await findStory(key);
  await put("read", key, {
    id: key,
    title: stored?.value?.title ?? key,
    at: Date.now(),
  }, { ifFull: "evictOldest" });
  await rewriteStory(key, true);
}

async function markUnread(id) {
  const key = String(id);
  await sdk.collections.delete("read", key);
  await rewriteStory(key, false);
}

exports.activate = async (ade) => {
  sdk = ade;
  try {
    const pref = await ade.collections.get("prefs", "feed");
    lastFeed = parseFeed(pref?.feed, "top");
  } catch {
    lastFeed = "top";
  }
  try {
    await loadFeed(lastFeed);
    log("info", "hn activated", { feed: lastFeed });
  } catch (error) {
    log("warn", "hn failed to load stories on activate", {
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await publishPanel(lastFeed);
    } catch (publishError) {
      log("warn", "hn failed to publish panel", {
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
  }
};

exports.deactivate = async () => {
  sdk = null;
};

async function openFeed(feed) {
  const count = await loadFeed(feed);
  return {
    message: `Loaded ${count} ${feed} stories.`,
    navigate: { panelId: "stories" },
    resetState: ["feed"],
  };
}

exports.actions = {
  async openStories() {
    return openFeed(lastFeed);
  },
  async openTop() {
    return openFeed("top");
  },
  async openNew() {
    return openFeed("new");
  },
  async openAsk() {
    return openFeed("ask");
  },
  async selectFeed(args) {
    const feed = feedFromArgs(args);
    const count = await loadFeed(feed);
    return { message: `Loaded ${count} ${feed} stories.` };
  },
  async refreshStories(args) {
    return exports.actions.selectFeed(args);
  },
  async openStory(args) {
    const id = String(args?.id ?? "");
    if (!id) return { ok: false, message: "No story id." };
    const stored = await findStory(id);
    const url = typeof stored?.value?.url === "string" ? stored.value.url : commentsUrl(id);
    await markRead(id);
    return { openUrl: url };
  },
  async openComments(args) {
    const id = String(args?.id ?? "");
    if (!id) return { ok: false, message: "No story id." };
    return { openUrl: commentsUrl(id) };
  },
  async markRead(args) {
    const id = String(args?.id ?? "");
    if (!id) return { ok: false, message: "No story id." };
    await markRead(id);
    return { message: "Marked as read." };
  },
  async markUnread(args) {
    const id = String(args?.id ?? "");
    if (!id) return { ok: false, message: "No story id." };
    await markUnread(id);
    return { message: "Marked unread." };
  },
  async stories() {
    const rows = await sdk.collections.list("stories", { limit: 50 });
    return {
      feed: lastFeed,
      count: rows.length,
      titles: rows.map((row) => row.value?.title).filter(Boolean),
    };
  },
};
