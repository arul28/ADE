"use strict";

const {
  KEEP_DAYS,
  cronForTime,
  expiredKeys,
  flagsAreStale,
  formatDay,
  inRange,
  isSlackWebhook,
  laneOptions,
  noteKey,
  noteRow,
  noteText,
  normalizeKind,
  rangeFlags,
  searchRows,
  standupText,
} = require("./journal");

/** Row actions the Journal and Today bindings are allowed to mint. */
const ROW_ACTIONS = ["deleteNote"];

/** How many stored rows a read walks. `collections.list` clamps to 1,000 whatever we ask for. */
const READ_LIMIT = 500;

/** State-collection keys. Prefixed so the settings panel's `keyValue` binding sees only its own three rows. */
const K_LAST_SESSION = "session:last";
const K_LANE_SNAPSHOT = "lanes:snapshot";
const K_STANDUP = "standup:text";
const K_SETTINGS_ROW = (n) => `settings:${n}`;

let sdk = null;
/** laneId → display name. Refreshed from `lane.list`; a miss only costs a note its lane label. */
let laneNames = new Map();
/** The chat a palette press or a schedule should attach its standup card to. */
let lastSessionId = null;

function log(level, message, fields) {
  try {
    sdk?.log(level, message, fields);
  } catch {
    // Logging must never be the thing that breaks a handler.
  }
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
}

/**
 * A budget-safe write.
 *
 * `evictOldest` handles the ordinary case — notes are a rolling window and the
 * oldest one is the one to lose. The catch is for the value that can never fit,
 * which eviction cannot rescue: skip that item and keep the plugin alive.
 */
async function put(collection, key, value, options = { ifFull: "evictOldest" }) {
  try {
    await sdk.collections.put(collection, key, value, options);
    return true;
  } catch (error) {
    if (errorCode(error) !== "plugin_budget_exceeded") throw error;
    log("warn", `Skipped ${collection}:${key} — the store is full.`);
    return false;
  }
}

async function readNotes(limit = READ_LIMIT) {
  const rows = await sdk.collections.list("notes", { limit });
  return rows.filter((row) => row.value && typeof row.value === "object");
}

/* ── Lanes ──────────────────────────────────────────────────────────────── */

async function refreshLanes() {
  try {
    const result = await sdk.actions.invoke("lane", "list", {});
    const lanes = Array.isArray(result) ? result : Array.isArray(result?.lanes) ? result.lanes : [];
    const next = new Map();
    for (const lane of lanes) {
      if (lane && typeof lane.id === "string") next.set(lane.id, String(lane.name ?? lane.id));
    }
    if (next.size) laneNames = next;
    return lanes;
  } catch (error) {
    log("warn", `Could not read lanes: ${error?.message ?? error}`);
    return [];
  }
}

/** The lane a chat belongs to. A summary ADE will not give us costs the tag, never the note. */
async function laneForSession(sessionId) {
  if (!sessionId) return { laneId: "", laneName: "" };
  try {
    const summary = await sdk.actions.invoke("chat", "getSessionSummary", { sessionId });
    const laneId = typeof summary?.laneId === "string" ? summary.laneId : "";
    if (!laneId) return { laneId: "", laneName: "" };
    if (!laneNames.has(laneId)) await refreshLanes();
    return { laneId, laneName: laneNames.get(laneId) ?? "" };
  } catch (error) {
    log("warn", `Could not resolve the lane for ${sessionId}: ${error?.message ?? error}`);
    return { laneId: "", laneName: "" };
  }
}

/* ── Writing a note ─────────────────────────────────────────────────────── */

let keySuffix = 0;

async function addNote({ text, kind, laneId, laneName }) {
  const body = noteText(text);
  if (!body) return null;
  const at = Date.now();
  keySuffix = (keySuffix + 1) % 10000;
  const key = noteKey(at, String(keySuffix).padStart(4, "0"));
  const value = noteRow({
    key,
    text: body,
    kind: normalizeKind(kind),
    laneId: laneId || "",
    laneName: laneName || laneNames.get(laneId) || "",
    at,
    now: at,
  });
  const stored = await put("notes", key, value);
  if (!stored) return null;
  void publishLaneBadges().catch(() => {});
  return { key, value };
}

/* ── Keeping the stored filter flags true ───────────────────────────────── */

/**
 * `today` and `week` are a function of NOW, so a row written yesterday still
 * claims to be today's until something rewrites it. Nothing else can: the
 * client only compares strings and never computes one.
 *
 * Only the newest rows can be stale — everything older than a week has carried
 * `""` in both fields since it aged out — so this walks a window, not the store.
 */
async function rollDayFlags() {
  const now = Date.now();
  let rolled = 0;
  try {
    for (const row of await readNotes(200)) {
      if (!flagsAreStale(row.value, now)) continue;
      const flags = rangeFlags(row.value.at, now);
      await put("notes", row.key, { ...row.value, ...flags });
      rolled += 1;
    }
  } catch (error) {
    log("warn", `Could not roll the day flags: ${error?.message ?? error}`);
  }
  return rolled;
}

/** Notes age out. 4,000 rows is not "forever", and history-shaped data has to be windowed. */
async function pruneOldNotes() {
  try {
    const rows = await sdk.collections.list("notes", { limit: 1000 });
    for (const key of expiredKeys(rows, Date.now())) {
      await sdk.collections.delete("notes", key);
    }
  } catch (error) {
    log("warn", `Could not prune old notes: ${error?.message ?? error}`);
  }
}

/* ── Lane badges ────────────────────────────────────────────────────────── */

/**
 * Today's note count, per lane.
 *
 * A lane with none publishes `null` rather than a zero row: the manifest's
 * declaration draws "0" as its placeholder, so clearing is what shows zero, and
 * it costs no contribution row to do it.
 */
async function publishLaneBadges() {
  const counts = new Map();
  try {
    for (const row of await readNotes(READ_LIMIT)) {
      if (row.value.today !== "today" || !row.value.laneKey) continue;
      counts.set(row.value.laneKey, (counts.get(row.value.laneKey) ?? 0) + 1);
    }
  } catch (error) {
    log("warn", `Could not count today's notes: ${error?.message ?? error}`);
    return;
  }
  for (const laneId of laneNames.keys()) {
    const count = counts.get(laneId) ?? 0;
    try {
      await sdk.contributions.publish(
        "lane",
        laneId,
        "row-badge",
        count
          ? { id: "lane-notes", text: String(count), tone: "accent", icon: "note", tooltip: `${count} journal note${count === 1 ? "" : "s"} today` }
          : null,
      );
    } catch (error) {
      log("warn", `Could not badge lane ${laneId}: ${error?.message ?? error}`);
    }
  }
}

/* ── Archived lanes write their own note ────────────────────────────────── */

/**
 * "wrapped up <lane>", once, when a lane's `archivedAt` turns from null to a
 * date.
 *
 * A fresh install seeds the snapshot and writes nothing: every lane the user
 * archived before installing this would otherwise land in today's journal and
 * in this morning's standup.
 */
async function syncArchivedLanes(lanes) {
  let previous = null;
  try {
    previous = await sdk.collections.get("state", K_LANE_SNAPSHOT);
  } catch {
    previous = null;
  }
  const snapshot = {};
  for (const lane of lanes) {
    if (lane && typeof lane.id === "string") snapshot[lane.id] = lane.archivedAt ?? null;
  }
  const seeding = !previous || typeof previous !== "object";
  if (!seeding) {
    for (const lane of lanes) {
      if (!lane || typeof lane.id !== "string" || !lane.archivedAt) continue;
      const before = previous[lane.id];
      // `undefined` is a lane this snapshot has never seen — an import or a
      // machine that just synced — and is not the same fact as "was not
      // archived a moment ago". Only a recorded null is a transition.
      if (before !== null) continue;
      await addNote({
        text: `wrapped up ${lane.name ?? lane.id}`,
        kind: "done",
        laneId: lane.id,
        laneName: lane.name ?? "",
      });
      log("info", `Logged the archive of lane ${lane.name ?? lane.id}.`);
    }
  }
  await put("state", K_LANE_SNAPSHOT, snapshot);
}

/* ── Panels ─────────────────────────────────────────────────────────────── */

function fallback(title, text, panelId) {
  return { title, text, deeplink: `ade://plugin/journal/${panelId}` };
}

/**
 * The Journal page, with its lane filter rebuilt from the lanes that actually
 * have notes.
 *
 * The control is OMITTED entirely until a second option exists. A `segmented`
 * holding one option is outside the vocabulary's 2–8 range, so a lone
 * "All lanes" would be dropped as a malformed node and draw an error marker —
 * and its `where` clause would then read a state key no control declares, which
 * is inactive rather than false, so the list would keep working while the
 * filter above it showed as broken. That is why this is a shape decision and
 * not a cosmetic one.
 */
function journalSchema(rows) {
  const lanes = laneOptions(rows);
  const hasLaneFilter = lanes.options.length >= 2;
  const hidden = lanes.hidden > 0
    ? [{ component: "text", text: `${lanes.hidden} more lane${lanes.hidden === 1 ? "" : "s"} have notes — a filter holds eight options, so the busiest are shown. "All lanes" still includes them.`, variant: "caption" }]
    : [];
  return {
    v: 1,
    title: "Journal",
    fallback: fallback("Journal", "Open ADE on a machine that has Work Journal installed to read your notes.", "journal"),
    body: [
      {
        component: "stack",
        direction: "vertical",
        gap: "md",
        children: [
          { component: "text", text: "Journal", variant: "title" },
          {
            component: "stack",
            direction: "horizontal",
            gap: "md",
            wrap: true,
            children: [
              {
                component: "segmented",
                stateKey: "range",
                label: "When",
                default: "today",
                options: [
                  { value: "", label: "All" },
                  { value: "today", label: "Today" },
                  { value: "week", label: "This week" },
                ],
              },
              {
                component: "segmented",
                stateKey: "kind",
                label: "What",
                default: "",
                options: [
                  { value: "", label: "All" },
                  { value: "blocked", label: "Blocked" },
                  { value: "done", label: "Done" },
                ],
              },
              ...(hasLaneFilter
                ? [{
                  component: "segmented",
                  stateKey: "lane",
                  label: "Lane",
                  default: "",
                  options: lanes.options,
                }]
                : []),
            ],
          },
          {
            component: "list",
            bind: {
              collection: "notes",
              limit: 100,
              allowActions: ROW_ACTIONS,
              where: [
                {
                  or: [
                    { field: "today", equals: { $state: "range" } },
                    { field: "week", equals: { $state: "range" } },
                  ],
                },
                { field: "kind", equals: { $state: "kind" } },
                ...(hasLaneFilter ? [{ field: "laneKey", equals: { $state: "lane" } }] : []),
              ],
            },
            emptyText: "No notes match this filter.",
          },
          ...hidden,
          {
            component: "stack",
            direction: "horizontal",
            gap: "sm",
            wrap: true,
            children: [
              { component: "button", label: "Write my standup", kind: "primary", icon: "sparkle", onPress: { action: "writeStandup" } },
              { component: "button", label: "Add a note", kind: "default", icon: "note", onPress: { action: "addNoteToLane" } },
            ],
          },
        ],
      },
    ],
  };
}

function standupSchema(text, postedAt) {
  return {
    v: 1,
    title: "Standup",
    fallback: fallback("Standup", text ? text.slice(0, 400) : "No standup written yet.", "standup"),
    body: [
      {
        component: "stack",
        direction: "vertical",
        gap: "sm",
        children: [
          { component: "text", text: `Standup — ${formatDay(Date.now())}`, variant: "title" },
          { component: "text", text: text || "Nothing logged today.", variant: "code" },
          ...(postedAt ? [{ component: "badge", text: `Posted to Slack at ${postedAt}`, tone: "success", icon: "rocket" }] : []),
          {
            component: "stack",
            direction: "horizontal",
            gap: "sm",
            wrap: true,
            children: [
              { component: "button", label: "Copy", kind: "primary", icon: "file", onPress: { action: "copyStandup" } },
              { component: "button", label: "Rewrite", kind: "default", icon: "sparkle", onPress: { action: "writeStandup" } },
              { component: "button", label: "Post to Slack", kind: "quiet", icon: "rocket", onPress: { action: "postStandup", confirm: "Post today's standup to Slack now?" } },
            ],
          },
        ],
      },
    ],
  };
}

async function republishJournal() {
  try {
    const rows = (await readNotes(READ_LIMIT)).map((row) => row.value);
    await sdk.panels.update("journal", journalSchema(rows));
  } catch (error) {
    log("warn", `Could not republish the journal panel: ${error?.message ?? error}`);
  }
}

/* ── Settings and the standup schedule ──────────────────────────────────── */

async function config() {
  try {
    return (await sdk.config.get()) ?? {};
  } catch {
    return {};
  }
}

async function webhookUrl() {
  try {
    return (await sdk.secrets.get("SLACK_WEBHOOK_URL")) ?? "";
  } catch {
    return "";
  }
}

/** The three rows the settings section's `keyValue` binding renders. Written, not computed, because a schema has no expressions. */
async function writeSettingsRows() {
  const cfg = await config();
  const time = String(cfg.standupTime ?? "09:30");
  const cron = cronForTime(time);
  const auto = cfg.autoPost === true;
  const hook = await webhookUrl();
  await put("state", K_SETTINGS_ROW(1), {
    key: "Standup time",
    value: cron ? time : `${time} — not a time of day, so nothing is scheduled`,
    tone: cron ? "neutral" : "warning",
  });
  await put("state", K_SETTINGS_ROW(2), {
    key: "Auto-post",
    value: auto ? (cron ? `On, daily at ${time}` : "On, but the time is unreadable") : "Off",
    tone: auto && cron ? "success" : "neutral",
  });
  await put("state", K_SETTINGS_ROW(3), {
    key: "Slack webhook",
    value: hook ? (isSlackWebhook(hook) ? "Set" : "Set, but it is not a hooks.slack.com URL") : "Not set",
    tone: hook && isSlackWebhook(hook) ? "success" : "neutral",
  });
}

/**
 * Exactly one standing claim on the clock, rebuilt from the current settings.
 *
 * Dropping ours first rather than diffing: eight live schedules is the quota
 * and a plugin that leaks one a day burns it in a week.
 */
async function syncSchedule() {
  const cfg = await config();
  const cron = cronForTime(cfg.standupTime ?? "09:30");
  const wanted = cfg.autoPost === true && cron;
  try {
    for (const schedule of (await sdk.schedules.list()) ?? []) {
      if (schedule?.action === "postStandup" && schedule?.scheduleId) {
        await sdk.schedules.delete(schedule.scheduleId);
      }
    }
    if (wanted) {
      await sdk.schedules.create({ action: "postStandup", cron, note: `Post the standup at ${cfg.standupTime}` });
      log("info", `Standup scheduled with cron "${cron}".`);
    }
  } catch (error) {
    log("warn", `Could not sync the standup schedule: ${error?.message ?? error}`);
  }
  await writeSettingsRows();
}

/* ── The standup itself ─────────────────────────────────────────────────── */

async function buildStandup() {
  const rows = (await readNotes(READ_LIMIT)).map((row) => row.value).filter((row) => inRange(row, "today"));
  return { text: standupText(rows, Date.now()), count: rows.length };
}

async function showStandup(sessionId, text, postedAt) {
  await put("state", K_STANDUP, { text, at: Date.now() });
  try {
    await sdk.panels.update("standup", standupSchema(text, postedAt));
  } catch (error) {
    log("warn", `Could not update the standup panel: ${error?.message ?? error}`);
  }
  if (!sessionId) return false;
  try {
    await sdk.contributions.publish("session", sessionId, "chat-card", {
      id: "standup",
      panelId: "standup",
      title: "Standup",
      icon: "list-checks",
    });
    return true;
  } catch (error) {
    log("warn", `Could not put the standup card in ${sessionId}: ${error?.message ?? error}`);
    return false;
  }
}

async function postToSlack(text) {
  const url = await webhookUrl();
  if (!url) return { ok: false, reason: "No Slack webhook URL is set — add one in Settings → Work Journal." };
  if (!isSlackWebhook(url)) return { ok: false, reason: "That webhook is not a https://hooks.slack.com URL, so it was not posted." };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) return { ok: false, reason: `Slack answered ${response.status}.` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Could not reach Slack: ${error?.message ?? error}` };
  }
}

/* ── Context readers ────────────────────────────────────────────────────── */

/**
 * The chat an action was fired from.
 *
 * `args.context` IS the projection — there is no `args.context.session`. A
 * chat header sends `{kind: "session", id}`, a composer sends
 * `{kind: "composer", sessionId}`, and a palette entry sends a surface with no
 * subject at all, which is what `lastSessionId` is for.
 */
function sessionFrom(args) {
  const context = args?.context;
  if (context?.kind === "session" && typeof context.id === "string") return context.id;
  if (context?.kind === "composer" && typeof context.sessionId === "string") return context.sessionId;
  return null;
}

function rememberSession(sessionId) {
  if (!sessionId || sessionId === lastSessionId) return;
  lastSessionId = sessionId;
  void put("state", K_LAST_SESSION, { sessionId, at: Date.now() }).catch(() => {});
}

/** What a chat-header press writes down, when the user gave us no words: the conversation's own title. */
function titleFrom(args) {
  const context = args?.context;
  const title = typeof context?.title === "string" ? context.title.trim() : "";
  return title || "";
}

/* ── Actions ────────────────────────────────────────────────────────────── */

async function logFromChat(args, kind) {
  const sessionId = sessionFrom(args);
  rememberSession(sessionId);
  const title = titleFrom(args);
  if (!title) {
    return { ok: false, message: "This chat has no title yet — type /note <your note> instead." };
  }
  const lane = await laneForSession(sessionId);
  const saved = await addNote({ text: title, kind, laneId: lane.laneId, laneName: lane.laneName });
  if (!saved) return { ok: false, message: "Could not save that note — the journal's store is full." };
  await republishJournal();
  const tag = kind === "blocked" ? " as blocked" : kind === "done" ? " as done" : "";
  const where = lane.laneName ? ` on ${lane.laneName}` : "";
  return { message: `Logged${tag}${where}: ${saved.value.title}` };
}

const actions = {
  /* The chat header's split button. */
  logIt: (args) => logFromChat(args, ""),
  logBlocked: (args) => logFromChat(args, "blocked"),
  logDone: (args) => logFromChat(args, "done"),

  /* `/note fixed the login bug` */
  async noteCommand(args) {
    const sessionId = sessionFrom(args);
    rememberSession(sessionId);
    const draft = typeof args?.context?.draft === "string" ? args.context.draft : "";
    const text = noteText(draft);
    if (!text) {
      return {
        ok: false,
        message: "Type the note after the command — /note fixed the login bug — or press \"Log it\" to save the chat's title.",
      };
    }
    // The composer's own lane, when it has one: a `composer` context carries it
    // directly and does not need a session lookup.
    const laneId = typeof args?.context?.laneId === "string" ? args.context.laneId : "";
    if (laneId && !laneNames.has(laneId)) await refreshLanes();
    const lane = laneId
      ? { laneId, laneName: laneNames.get(laneId) ?? "" }
      : await laneForSession(sessionId);
    const saved = await addNote({ text, kind: "", laneId: lane.laneId, laneName: lane.laneName });
    if (!saved) return { ok: false, message: "Could not save that note — the journal's store is full." };
    await republishJournal();
    // Clear the draft: the words were the note, and leaving them in the box
    // invites the user to send them to the agent as well.
    return {
      composer: { replaceText: "" },
      message: `Logged${lane.laneName ? ` on ${lane.laneName}` : ""}: ${saved.value.title}`,
    };
  },

  /* Lanes → right-click → Add a note, and the two panels' "Add a note" buttons. */
  async addNoteToLane(args) {
    const context = args?.context;
    const laneId = context?.kind === "lane" && typeof context.id === "string" ? context.id : "";
    const laneName = context?.kind === "lane" && typeof context.name === "string" ? context.name : "";
    return {
      navigate: {
        panelId: "compose",
        context: laneId ? { Lane: laneName || laneId, laneId } : {},
      },
    };
  },

  async submitNote(args) {
    const text = noteText(args?.text);
    if (!text) return { ok: false, message: "Write the note first." };
    const laneId = typeof args?.context?.laneId === "string" ? args.context.laneId : "";
    if (laneId && !laneNames.has(laneId)) await refreshLanes();
    const saved = await addNote({ text, kind: args?.kind, laneId, laneName: laneNames.get(laneId) ?? "" });
    if (!saved) return { ok: false, message: "Could not save that note — the journal's store is full." };
    await republishJournal();
    return { navigate: { panelId: "journal" }, message: `Logged: ${saved.value.title}` };
  },

  async deleteNote(args) {
    const key = typeof args?.key === "string" ? args.key : "";
    if (!key) return { ok: false, message: "That row carried no note id." };
    await sdk.collections.delete("notes", key);
    await publishLaneBadges();
    await republishJournal();
    return { message: "Note deleted." };
  },

  async writeStandup(args) {
    const sessionId = sessionFrom(args) ?? lastSessionId;
    rememberSession(sessionId);
    await rollDayFlags();
    const { text, count } = await buildStandup();
    const carded = await showStandup(sessionId, text, null);
    if (!count) {
      return { navigate: { panelId: "standup" }, message: "Nothing logged today yet, so the standup is empty." };
    }
    if (carded) {
      return { message: `Standup written from ${count} note${count === 1 ? "" : "s"} — the card is in this chat.` };
    }
    return {
      navigate: { panelId: "standup" },
      message: `Standup written from ${count} note${count === 1 ? "" : "s"}. No chat to card it into, so it is open here.`,
    };
  },

  async copyStandup() {
    const stored = await sdk.collections.get("state", K_STANDUP);
    const text = typeof stored?.text === "string" ? stored.text : "";
    if (!text) return { ok: false, message: "Nothing to copy yet — write the standup first." };
    try {
      await sdk.clipboard.write(text);
      return { message: "Standup copied." };
    } catch (error) {
      if (errorCode(error) === "desktop_unavailable") {
        return { ok: false, message: "This machine has no clipboard to write to — select the text instead." };
      }
      throw error;
    }
  },

  async postStandup(args) {
    await rollDayFlags();
    const { text, count } = await buildStandup();
    const sessionId = sessionFrom(args) ?? lastSessionId;
    if (!count) {
      log("info", "Standup not posted: nothing logged today.");
      return { ok: false, message: "Nothing logged today, so nothing was posted." };
    }
    const posted = await postToSlack(text);
    const at = posted.ok ? new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
    await showStandup(sessionId, text, at);
    if (!posted.ok) {
      log("warn", `Standup not posted: ${posted.reason}`);
      return { ok: false, message: posted.reason };
    }
    try {
      await sdk.notifications.post({
        title: "Standup posted",
        body: `${count} note${count === 1 ? "" : "s"} sent to Slack.`,
        deeplink: "ade://plugin/journal/journal",
      });
    } catch (error) {
      // A notification ADE could not deliver never costs the post itself.
      log("warn", `Standup posted, notification not delivered: ${error?.message ?? error}`);
    }
    return { message: `Standup posted to Slack — ${count} note${count === 1 ? "" : "s"}.` };
  },

  openJournal: async () => ({ navigate: { panelId: "journal" } }),

  /* Panel refresh gestures: the Refresh button on desktop and web, pull-to-refresh on the phone. */
  async refreshJournal() {
    await refreshLanes();
    await rollDayFlags();
    await publishLaneBadges();
    await republishJournal();
    return { message: "Journal refreshed." };
  },

  async refreshToday() {
    await rollDayFlags();
    await publishLaneBadges();
    return { message: "Today refreshed." };
  },

  /* Settings section. */
  async applySettings(args) {
    const url = typeof args?.slackWebhookUrl === "string" ? args.slackWebhookUrl.trim() : "";
    if (url) {
      if (!isSlackWebhook(url)) {
        return { ok: false, message: "That is not a https://hooks.slack.com/… URL, so it was not saved." };
      }
      await sdk.secrets.set("SLACK_WEBHOOK_URL", url);
    }
    await syncSchedule();
    const cfg = await config();
    const cron = cronForTime(cfg.standupTime ?? "09:30");
    if (!cron) {
      return { ok: false, message: "Saved, but the standup time is not an HH:MM time of day, so nothing is scheduled." };
    }
    return {
      message: cfg.autoPost === true
        ? `Saved. Your standup posts daily at ${cfg.standupTime}.`
        : "Saved. Auto-post is off, so nothing is scheduled.",
    };
  },

  /* ⌘K search. Live on a debounced keystroke and dropped after 300 ms, so it stays a substring scan. */
  async searchNotes(args) {
    const resultId = typeof args?.resultId === "string" ? args.resultId : "";
    if (resultId) return { navigate: { panelId: "journal" } };
    const rows = (await readNotes(READ_LIMIT)).map((row) => ({ key: row.key, ...row.value }));
    return {
      results: searchRows(rows, args?.query).map((row) => ({
        id: row.key,
        title: row.text,
        subtitle: `${row.laneName} · ${formatDay(row.at)}`,
        navigate: { panelId: "journal" },
      })),
    };
  },

  /* Agent tools. */
  async toolAddNote(args) {
    const text = noteText(args?.text);
    if (!text) return { ok: false, error: "text is required and must be a non-empty line." };
    const laneId = typeof args?.laneId === "string" ? args.laneId : "";
    if (laneId && !laneNames.has(laneId)) await refreshLanes();
    const saved = await addNote({ text, kind: args?.kind, laneId, laneName: laneNames.get(laneId) ?? "" });
    if (!saved) return { ok: false, error: "The journal's store is full, so the note was not saved." };
    await republishJournal();
    return { ok: true, note: saved.value.title, lane: cliLane(saved.value), kind: saved.value.kind || "note" };
  },

  async toolListNotes(args) {
    const range = ["today", "week", "all"].includes(args?.range) ? args.range : "today";
    await rollDayFlags();
    const rows = (await readNotes(READ_LIMIT)).map((row) => row.value).filter((row) => inRange(row, range));
    return {
      range,
      count: rows.length,
      notes: rows.map(cliNote),
    };
  },

  /* `ade journal …` */
  async today() {
    await rollDayFlags();
    const rows = (await readNotes(READ_LIMIT)).map((row) => row.value).filter((row) => inRange(row, "today"));
    return { day: formatDay(Date.now()), count: rows.length, notes: rows.map(cliNote) };
  },

  async week() {
    await rollDayFlags();
    const rows = (await readNotes(READ_LIMIT)).map((row) => row.value).filter((row) => inRange(row, "week"));
    return { count: rows.length, notes: rows.map(cliNote) };
  },

  async standup() {
    await rollDayFlags();
    const { text, count } = await buildStandup();
    await showStandup(lastSessionId, text, null);
    return { count, standup: text };
  },

  /* `ade journal add "fixed the login bug" --done` */
  async add(args) {
    const argv = Array.isArray(args?.argv) ? args.argv : [];
    const flags = argv.filter((word) => word.startsWith("--")).map((word) => word.slice(2));
    // `argv` still holds the command word itself, and it is not always first
    // (`ade journal --done add "…"`), so drop the flags and then drop the word.
    const words = argv.filter((word) => !word.startsWith("-"));
    const text = noteText(words.slice(1).join(" "));
    if (!text) return { ok: false, error: 'Use: ade journal add "your note" [--done|--blocked] [--lane <name>]' };
    const kind = flags.includes("done") ? "done" : flags.includes("blocked") ? "blocked" : "";
    const laneFlag = argv.indexOf("--lane");
    const wanted = laneFlag >= 0 ? argv[laneFlag + 1] : "";
    await refreshLanes();
    let laneId = "";
    if (wanted) {
      for (const [id, name] of laneNames) {
        if (name.toLowerCase() === String(wanted).toLowerCase()) laneId = id;
      }
      if (!laneId) return { ok: false, error: `No lane named "${wanted}" on this machine.` };
    }
    const saved = await addNote({ text, kind, laneId, laneName: laneNames.get(laneId) ?? "" });
    if (!saved) return { ok: false, error: "The journal's store is full, so the note was not saved." };
    await republishJournal();
    return { ok: true, note: saved.value.title, lane: cliLane(saved.value), kind: saved.value.kind || "note" };
  },
};

/**
 * The lane, for a reader that is a script rather than a person.
 *
 * `laneName` is `"no lane"` because that is what reads correctly on a row on
 * screen. In JSON it would be a lane called "no lane", which is a thing a
 * script would go looking for.
 */
function cliLane(row) {
  return row.laneKey ? row.laneName : "";
}

function cliNote(row) {
  return {
    text: row.text,
    lane: cliLane(row),
    kind: row.kind || "note",
    at: new Date(row.at).toISOString(),
  };
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

/**
 * Everything slow is started, not awaited.
 *
 * The bootstrap sends `ready` only once this resolves, on a 20-second clock —
 * and a lane list against a cold brain is not always fast. A plugin that times
 * out its own startup is restarted, times out again, and is dead after five
 * tries, with nothing in the log naming slowness as the cause.
 */
exports.activate = async (ade) => {
  sdk = ade;

  try {
    const stored = await ade.collections.get("state", K_LAST_SESSION);
    if (typeof stored?.sessionId === "string") lastSessionId = stored.sessionId;
  } catch {
    // A missing pointer only costs the palette its chat card until the next turn.
  }

  // The agent's own chats tell us which conversation a palette press means.
  ade.events.on("turn.start", ({ sessionId }) => rememberSession(sessionId));

  // A lane list is the only way to learn an archive happened; `lane.changed` is
  // the signal, not the payload.
  ade.events.on("lane.changed", () => {
    void (async () => {
      const lanes = await refreshLanes();
      if (lanes.length) await syncArchivedLanes(lanes);
      await publishLaneBadges();
      await republishJournal();
    })().catch((error) => log("warn", `lane.changed handler failed: ${error?.message ?? error}`));
  });

  void (async () => {
    const lanes = await refreshLanes();
    if (lanes.length) await syncArchivedLanes(lanes);
    await rollDayFlags();
    await pruneOldNotes();
    await publishLaneBadges();
    await republishJournal();
    await syncSchedule();
    log("info", `Work Journal ready. ${laneNames.size} lane(s) known, notes kept for ${KEEP_DAYS} days.`);
  })().catch((error) => log("warn", `First load failed: ${error?.message ?? error}`));
};

exports.deactivate = async () => {
  sdk = null;
};

exports.actions = actions;
