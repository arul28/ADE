"use strict";

/**
 * Decision Log — one line, one press, kept with its lane and its date.
 *
 * Three things decide the shape of this file.
 *
 * 1. **Rows are stored in render shape.** A `list` binding does no reshaping,
 *    so the value written to `decisions` IS the row four clients draw. The
 *    filter fields (`at`, `laneId`, `status`) ride on the same object because
 *    a binding's `where` compares top-level fields of the stored row.
 *
 * 2. **Keys sort newest-first.** `collections.list` and a panel binding both
 *    read in key order, and there is no "order by" in the vocabulary, so the
 *    key carries the ordering: an inverted millisecond timestamp. That is also
 *    what makes pruning the tail a slice rather than a sort.
 *
 * 3. **A ceiling is a normal state.** Every `put` is wrapped, the store is a
 *    bounded window, and a refusal costs the newest row and nothing else.
 */

const KEY_PREFIX = "dec:";
/** Inverted-timestamp base. Comfortably past any real clock, fixed width. */
const KEY_EPOCH = 9999999999999;
/** Bounded window. History-shaped data must not append forever. */
const MAX_DECISIONS = 400;
/** `maxListItems` is 100; asking for more than the panel can draw is waste. */
const LIST_LIMIT = 100;
/** `maxStateOptions` is 8, and one of them is "All lanes". */
const MAX_LANE_OPTIONS = 7;
const MAX_TITLE_CHARS = 200;
const DIGEST_ACTION = "weeklyDigest";

const DAY_LABELS = {
  "0": "Sunday",
  "1": "Monday",
  "2": "Tuesday",
  "3": "Wednesday",
  "4": "Thursday",
  "5": "Friday",
  "6": "Saturday",
};

/** @type {any} */
let sdk = null;
/** laneId -> display name, resolved one lane at a time from `lane.getSummary`. */
const laneNames = new Map();
/** laneId -> the badge text we last published, so we publish only on change. */
const publishedBadges = new Map();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function decisionKey(ms, salt) {
  const inverted = String(KEY_EPOCH - ms).padStart(13, "0");
  return `${KEY_PREFIX}${inverted}:${salt}`;
}

function randomSalt() {
  return Math.random().toString(36).slice(2, 8);
}

function dateLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function truncate(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Every `put` goes through here.
 *
 * `evictOldest` handles budget pressure on a collection that is a window by
 * design; the catch handles a value that can never fit. Neither is allowed to
 * be fatal — see the module comment.
 */
async function safePut(collection, key, value) {
  try {
    await sdk.collections.put(collection, key, value, { ifFull: "evictOldest" });
    return true;
  } catch (error) {
    if (error && error.code === "plugin_budget_exceeded") {
      sdk.log("warn", `Skipped ${key}: the decision store is full.`);
      return false;
    }
    throw error;
  }
}

/** Ask ADE, and treat a refusal as "we do not know" rather than as a fault. */
async function invokeQuietly(domain, action, args) {
  try {
    return await sdk.actions.invoke(domain, action, args);
  } catch (error) {
    // `warn`, not `debug`: a lane lookup that quietly fails degrades every
    // decision's subtitle to "Lane 1b4714f3", which reads as the plugin not
    // knowing your lanes rather than as a refused call.
    sdk.log("warn", `${domain}.${action} unavailable: ${error && error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading the store
// ---------------------------------------------------------------------------

async function listDecisions(limit) {
  const rows = await sdk.collections.list("decisions", {
    keyPrefix: KEY_PREFIX,
    limit: limit ?? 1000,
  });
  // Keys are inverted timestamps, and `list` orders by key, so this is already
  // newest-first. Sorting again here would be the only place the two orderings
  // could disagree.
  return rows.filter((row) => row && row.value && typeof row.value === "object");
}

// ---------------------------------------------------------------------------
// Lane names
// ---------------------------------------------------------------------------

/**
 * Resolve one lane's display name.
 *
 * `lane.getSummary` takes a lane id and answers; `lane.list` is project-scoped
 * and answers a plugin with an empty list rather than an error, which is how a
 * bulk lookup silently degraded every subtitle to "Lane 1b4714f3". Ask about
 * the lanes we actually have decisions in, one at a time, and cache.
 */
async function resolveLaneName(laneId, { force = false } = {}) {
  if (!laneId) return null;
  if (!force && laneNames.has(laneId)) return laneNames.get(laneId);
  const summary = await invokeQuietly("lane", "getSummary", { laneId });
  if (summary && typeof summary.name === "string" && summary.name) {
    laneNames.set(laneId, summary.name);
    return summary.name;
  }
  return laneNames.get(laneId) ?? null;
}

/**
 * Resolve every lane the log mentions, and rewrite any row whose stored name
 * has gone stale — a renamed lane must not leave old decisions labelled with a
 * name that no longer exists anywhere in the product.
 */
async function reconcileLaneNames({ force = false } = {}) {
  const rows = await listDecisions(1000);
  const laneIds = new Set(rows.map((row) => row.value.laneId).filter(Boolean));
  for (const laneId of laneIds) await resolveLaneName(laneId, { force });

  for (const row of rows) {
    const laneId = row.value.laneId;
    if (!laneId) continue;
    const current = laneNames.get(laneId);
    if (!current || current === row.value.laneName) continue;
    await safePut(
      "decisions",
      row.key,
      buildRow({
        key: row.key,
        text: row.value.text,
        at: row.value.at,
        laneId,
        laneName: current,
        status: row.value.status,
      }),
    );
  }
}

function laneNameFor(laneId, fallback) {
  if (!laneId) return "No lane";
  return laneNames.get(laneId) || fallback || `Lane ${laneId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// The row a client draws
// ---------------------------------------------------------------------------

function buildRow(decision) {
  const reversed = decision.status === "reversed";
  const laneName = laneNameFor(decision.laneId, decision.laneName);
  const row = {
    // --- what a `list` binding renders ---
    title: truncate(decision.text, MAX_TITLE_CHARS),
    subtitle: `${laneName} · ${dateLabel(decision.at)}`,
    tone: reversed ? "warning" : "neutral",
    overflow: reversed
      ? [
          {
            action: "unreverseDecision",
            label: "Undo reversal",
            args: { key: decision.key },
          },
        ]
      : [
          {
            action: "reverseDecision",
            label: "Mark as reversed",
            args: { key: decision.key },
            confirm: "Mark this decision as reversed? It stays in the log, marked.",
          },
        ],
    // --- what a `where` clause compares, and what we read back ---
    at: decision.at,
    laneId: decision.laneId || "",
    laneName,
    status: reversed ? "reversed" : "active",
    text: decision.text,
    key: decision.key,
  };
  if (reversed) row.badge = { text: "Reversed", tone: "warning" };
  return row;
}

// ---------------------------------------------------------------------------
// Writing a decision
// ---------------------------------------------------------------------------

async function writeDecision({ text, laneId, laneName }) {
  // Resolve the name BEFORE building the row: the row is what four clients
  // draw, and a subtitle written from a fallback stays wrong until something
  // rewrites it.
  const resolved = (await resolveLaneName(laneId)) ?? laneName;
  const now = Date.now();
  const at = new Date(now).toISOString();
  const key = decisionKey(now, randomSalt());
  const row = buildRow({ key, text, at, laneId, laneName: resolved, status: "active" });
  const stored = await safePut("decisions", key, row);
  if (!stored) return null;
  await prune();
  return row;
}

/** Keep the newest `MAX_DECISIONS`; roll the rest off. */
async function prune() {
  const rows = await listDecisions(1000);
  if (rows.length <= MAX_DECISIONS) return;
  for (const row of rows.slice(MAX_DECISIONS)) {
    await sdk.collections.delete("decisions", row.key);
  }
}

// ---------------------------------------------------------------------------
// Lane badges — publish on change, clear at zero
// ---------------------------------------------------------------------------

async function refreshLaneBadges() {
  const rows = await listDecisions(1000);
  const counts = new Map();
  for (const row of rows) {
    const laneId = row.value.laneId;
    if (!laneId) continue;
    if (row.value.status === "reversed") continue;
    counts.set(laneId, (counts.get(laneId) || 0) + 1);
  }

  // A lane that has decisions gets a count; one that has none gets nothing at
  // all — a declared badge draws no row until something publishes for it, and
  // `null` is how a row is taken back off.
  for (const [laneId, count] of counts) {
    const text = String(count);
    if (publishedBadges.get(laneId) === text) continue;
    await sdk.contributions.publish("lane", laneId, "row-badge", {
      id: "count",
      text,
      tone: "accent",
      tooltip: count === 1 ? "1 decision logged" : `${count} decisions logged`,
    });
    publishedBadges.set(laneId, text);
  }
  for (const laneId of [...publishedBadges.keys()]) {
    if (counts.has(laneId)) continue;
    await sdk.contributions.publish("lane", laneId, "row-badge", null);
    publishedBadges.delete(laneId);
  }
}

// ---------------------------------------------------------------------------
// The Decisions page, rebuilt with the lanes that actually have decisions
// ---------------------------------------------------------------------------

async function republishLogPanel() {
  const rows = await listDecisions(1000);

  // Most-recently-used lanes first — the rows are already newest-first, so the
  // first time a lane appears is the last time it was decided in.
  const seen = [];
  for (const row of rows) {
    const laneId = row.value.laneId;
    if (!laneId || seen.some((lane) => lane.value === laneId)) continue;
    seen.push({ value: laneId, label: truncate(laneNameFor(laneId, row.value.laneName), 40) });
  }
  const laneOptions = seen.slice(0, MAX_LANE_OPTIONS);
  const hiddenLanes = Math.max(0, seen.length - laneOptions.length);

  const filters = [
    {
      component: "segmented",
      stateKey: "range",
      label: "When",
      default: "",
      options: [
        { value: "", label: "All", badge: rows.length },
        { value: "-7d", label: "Last 7 days" },
        { value: "-30d", label: "Last 30 days" },
      ],
    },
  ];
  // A control needs at least two options, so the lane filter appears only once
  // there is a lane to filter to. Below that it would be a switch with one side.
  if (laneOptions.length > 0) {
    filters.push({
      component: "segmented",
      stateKey: "lane",
      label: "Lane",
      default: "",
      options: [{ value: "", label: "All lanes" }, ...laneOptions],
    });
  }

  const children = [
    { component: "stack", direction: "horizontal", gap: "md", wrap: true, children: filters },
    {
      component: "list",
      emptyText: 'No decisions here yet. Press "Log decision" at the top of any chat.',
      bind: {
        collection: "decisions",
        keyPrefix: KEY_PREFIX,
        limit: LIST_LIMIT,
        allowActions: ["reverseDecision", "unreverseDecision"],
        where: [
          { field: "at", since: { $state: "range" } },
          { field: "laneId", equals: { $state: "lane" } },
        ],
      },
    },
  ];

  // Say what was left out rather than letting the filter look complete.
  if (hiddenLanes > 0) {
    children.push({
      component: "text",
      variant: "caption",
      text: `Showing the ${MAX_LANE_OPTIONS} most recent lanes. ${hiddenLanes} older ${
        hiddenLanes === 1 ? "lane is" : "lanes are"
      } not in this filter — clear it to see every decision.`,
    });
  }

  await sdk.panels.update("log", {
    v: 1,
    title: "Decisions",
    fallback: {
      title: "Decisions",
      text: "Open ADE to read your decision log.",
      deeplink: "ade://plugin/decision-log/log",
    },
    body: [{ component: "stack", direction: "vertical", gap: "md", children }],
  });
}

// ---------------------------------------------------------------------------
// Settings — the form is drawn from the config it will write back
// ---------------------------------------------------------------------------

/**
 * The settings section, with no Apply button.
 *
 * `form` cannot do this: its `submit` is required, so every form-shaped
 * settings panel grows a button the user has to press before anything happens.
 * `segmented` is the one control that owns state and can report a change, so
 * the section is built from two of them and `onChange` applies the change on
 * the spot — the config write AND the reschedule, in the same round trip.
 */
async function republishSettingsPanel() {
  const config = await sdk.config.get();
  const enabled = config.digestEnabled === true;
  const day = typeof config.digestDay === "string" && DAY_LABELS[config.digestDay] ? config.digestDay : "1";

  const children = [
    {
      component: "segmented",
      stateKey: "digestEnabled",
      label: "Weekly digest",
      style: "toggle",
      default: enabled ? "on" : "off",
      options: [
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ],
      onChange: { action: "applyDigestSettings" },
    },
  ];
  // Only ask which day once there is a digest to send — a day picker under an
  // Off switch is a control with no effect.
  if (enabled) {
    children.push({
      component: "segmented",
      stateKey: "digestDay",
      label: "Send it on",
      default: day,
      options: Object.keys(DAY_LABELS).map((value) => ({ value, label: DAY_LABELS[value].slice(0, 3) })),
      onChange: { action: "applyDigestSettings" },
    });
  }
  children.push({
    component: "text",
    variant: "caption",
    text: enabled
      ? `Sending every ${DAY_LABELS[day]} at 09:13. Changes apply immediately.`
      : "Turn this on for a weekly notification summarizing what you logged.",
  });

  await sdk.panels.update("settings", {
    v: 1,
    title: "Decision Log",
    fallback: {
      title: "Decision Log",
      text: "Open ADE on a computer to change the weekly digest.",
      deeplink: "ade://plugin/decision-log/log",
    },
    body: [{ component: "stack", direction: "vertical", gap: "md", children }],
  });
}

/**
 * Put the schedule where the settings say it should be, right now.
 *
 * This is what makes "no restart" true: the setting and the standing claim on
 * the clock are reconciled inside the action that wrote the setting, not at
 * the next activate.
 */
async function applyDigestSchedule() {
  const config = await sdk.config.get();
  const enabled = config.digestEnabled === true;
  const day = typeof config.digestDay === "string" && DAY_LABELS[config.digestDay] ? config.digestDay : "1";

  const existing = await sdk.schedules.list();
  // A schedule row's id is `id`. Deleting `row.scheduleId` is `undefined`,
  // which the host refuses — and the old schedule then survives every save,
  // stacking toward the 8-live ceiling one day change at a time.
  const ours = (Array.isArray(existing) ? existing : []).filter((row) => row && row.action === DIGEST_ACTION);
  for (const row of ours) {
    await sdk.schedules.delete(row.id);
  }
  if (!enabled) return { enabled: false, day };

  // An off-the-hour minute, so a fleet of these does not all fire at :00.
  await sdk.schedules.create({
    action: DIGEST_ACTION,
    cron: `13 9 * * ${day}`,
    note: "Decision Log weekly digest",
  });
  return { enabled: true, day };
}

// ---------------------------------------------------------------------------
// Who are we logging for?
// ---------------------------------------------------------------------------

/**
 * Resolve the chat and the lane a press came from.
 *
 * A chat header action is handed the `session` directly. A palette entry is
 * handed `{kind: "surface"}` and reports what the reader was looking at under
 * `args.subject` — which is `"none"` often enough that guessing is worse than
 * saying so.
 */
async function resolveSubject(args) {
  const context = args && args.context;
  const subject = args && args.subject;

  let sessionId = null;
  let laneId = null;
  let laneName = null;

  if (context && context.kind === "session" && typeof context.id === "string") {
    sessionId = context.id;
  } else if (subject && subject.kind === "session" && typeof subject.id === "string") {
    sessionId = subject.id;
  } else if (subject && subject.kind === "lane" && typeof subject.id === "string") {
    laneId = subject.id;
    laneName = typeof subject.name === "string" ? subject.name : null;
  }

  if (sessionId && !laneId) {
    const summary = await invokeQuietly("chat", "getSessionSummary", { sessionId });
    if (summary && typeof summary.laneId === "string") laneId = summary.laneId;
  }

  return { sessionId, laneId, laneName };
}

// ---------------------------------------------------------------------------
// The confirmation card
// ---------------------------------------------------------------------------

async function emitConfirmationCard(sessionId, row) {
  if (!sessionId) return;
  const when = dateLabel(row.at);
  await invokeQuietly("chat", "emitAdeCard", {
    sessionId,
    card: {
      cardId: `decision-${row.key}`,
      variant: "decision_logged",
      state: "terminal",
      title: "Decision logged",
      // The lane and the date ride in the SUBTITLE, not only in `rows` and the
      // panel's `$context`. Observed on a real device: a card whose variant no
      // client knows drew its title and subtitle but neither its `rows` nor its
      // panel's `$context`, so a decision logged from the phone read
      // "Decision logged / Hi / Logged." with the lane and date nowhere. The
      // subtitle is the one line that renders everywhere, so put the answer in
      // it and treat the richer fields as enhancement.
      subtitle: `${row.title} — ${row.laneName} · ${when}`,
      fallbackText: `Decision logged — "${row.title}" · ${row.laneName} · ${when}`,
      rows: [
        { icon: "info", text: "Lane", detail: row.laneName },
        { icon: "info", text: "Logged", detail: when },
      ],
      // The panel is what makes this a rich card on a client that has never
      // heard of `decision_logged`; `$context` is what makes it about THIS
      // decision rather than about the newest one.
      panel: {
        panelId: "card",
        context: { Decision: row.text, Lane: row.laneName, Logged: when },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Reacting to a write
// ---------------------------------------------------------------------------

async function afterChange({ forceLaneNames = false } = {}) {
  await reconcileLaneNames({ force: forceLaneNames });
  await refreshLaneBadges();
  await republishLogPanel();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

exports.activate = async (ade) => {
  sdk = ade;

  // A fresh activation is a fresh host: a reload may be pointing at a renamed
  // lane or a store this process has never seen, and `publishedBadges` is a
  // record of what WE published, which after a restart we cannot claim to know.
  laneNames.clear();
  publishedBadges.clear();

  // Fast and local: safe to await before `ready`.
  await republishSettingsPanel().catch((error) => ade.log("warn", `settings panel: ${error.message}`));

  // Everything that talks to another service is started, not awaited — the
  // bootstrap sends `ready` only once this resolves, on a 20s clock.
  void (async () => {
    await afterChange();
    await applyDigestSchedule();
  })().catch((error) => ade.log("warn", `first load failed: ${error.message}`));

  // A lane changed — it may have been RENAMED, so re-ask rather than trusting
  // the cache that is exactly what a rename invalidates.
  ade.events.on("lane.changed", () => {
    void afterChange({ forceLaneNames: true }).catch((error) =>
      ade.log("warn", `lane refresh failed: ${error.message}`),
    );
  });
};

exports.deactivate = async () => {
  laneNames.clear();
  publishedBadges.clear();
  sdk = null;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

exports.actions = {
  /**
   * The chat header button and the ⌘K entry, both. One press asks for the
   * line; the client re-invokes this same handler with the answer.
   */
  async logDecision(args) {
    if (!args || !args.prompt) {
      const subject = await resolveSubject(args);
      if (!subject.sessionId && !subject.laneId) {
        return { ok: false, message: "Open a chat or select a lane first, then log the decision." };
      }
      return {
        prompt: {
          id: "decision",
          title: "What did you decide?",
          placeholder: "We're going with Postgres",
          submitLabel: "Log",
          context: {
            sessionId: subject.sessionId,
            laneId: subject.laneId,
            laneName: subject.laneName,
          },
        },
      };
    }

    const text = String(args.prompt.text || "").trim();
    if (!text) return { ok: false, message: "Nothing logged — the decision was empty." };

    const carried = args.prompt.context || {};
    const row = await writeDecision({
      text,
      laneId: carried.laneId || null,
      laneName: carried.laneName || null,
    });
    if (!row) {
      return { ok: false, message: "Could not log this decision — the store is full." };
    }

    await emitConfirmationCard(carried.sessionId, row);
    await afterChange();
    return { message: `Logged against ${row.laneName}.` };
  },

  /** The chat button's dropdown entry. */
  async openLog() {
    return { navigate: { panelId: "log" } };
  },

  async reverseDecision(args) {
    return setReversed(args, true);
  },

  async unreverseDecision(args) {
    return setReversed(args, false);
  },

  /** The Decisions page's refresh gesture. `$rel` filters need one. */
  async refreshLog() {
    // The reader asked for new data, so re-ask about the lanes too rather than
    // redrawing the cache they were already looking at.
    await afterChange({ forceLaneNames: true });
    return { ok: true };
  },

  /**
   * The settings section, applied on change. There is no Save press: the
   * control writes its own state, then this runs, and it is what makes the
   * change take effect with no restart and no Apply button.
   */
  async applyDigestSettings(args) {
    const state = (args && args.state) || {};
    // `state` carries the option VALUES the reader selected, so this reads the
    // control rather than a form payload.
    const enabled = state.digestEnabled === "on";
    const day = typeof state.digestDay === "string" && DAY_LABELS[state.digestDay] ? state.digestDay : null;
    const current = await sdk.config.get();
    const nextDay = day ?? (DAY_LABELS[current.digestDay] ? current.digestDay : "1");
    await sdk.config.set({ digestEnabled: enabled, digestDay: nextDay });
    const applied = await applyDigestSchedule();
    await republishSettingsPanel();
    return {
      message: applied.enabled
        ? `Weekly digest on, every ${DAY_LABELS[applied.day]} at 09:13. It is scheduled now — no restart.`
        : "Weekly digest off. The schedule has been removed.",
    };
  },

  /** The scheduled job, and `ade decision-log digest`. */
  async weeklyDigest() {
    const rows = await listDecisions(1000);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = rows.filter((row) => {
      const at = Date.parse(row.value.at);
      return Number.isFinite(at) && at >= cutoff;
    });
    if (recent.length === 0) {
      return { message: "No decisions in the last 7 days — nothing to send." };
    }
    const lanes = new Set(recent.map((row) => row.value.laneName).filter(Boolean));
    const headline = recent
      .slice(0, 3)
      .map((row) => row.value.title)
      .join(" · ");
    // 240 characters is the notification body ceiling; say what was left out
    // rather than letting three decisions read as the whole week.
    const body = truncate(`${headline}${recent.length > 3 ? ` · +${recent.length - 3} more` : ""}`, 240);
    const title = `${recent.length} decision${recent.length === 1 ? "" : "s"} this week`;

    // The notification is the digest. A host with no way to reach the user
    // (a headless daemon) refuses it, and that is worth retrying next week
    // rather than treating as a failure of the plugin.
    try {
      await sdk.notifications.post({
        title,
        body,
        deeplink: "ade://plugin/decision-log/log",
      });
    } catch (error) {
      sdk.log("warn", `digest not delivered: ${error && error.message}`);
      return { ok: false, message: `${title} — could not send the notification here.`, count: recent.length };
    }
    return { message: `${title} — sent.`, count: recent.length, lanes: [...lanes] };
  },

  // --- CLI words ---------------------------------------------------------

  /** `ade decision-log log "we're going with Postgres"` */
  async log(args) {
    const argv = Array.isArray(args && args.argv) ? args.argv.slice(1) : [];
    const text = argv.join(" ").trim();
    if (!text) return { ok: false, message: 'Usage: ade decision-log log "what you decided"' };
    const row = await writeDecision({ text, laneId: null, laneName: null });
    if (!row) return { ok: false, message: "Could not log — the store is full." };
    await afterChange();
    return { logged: row.title, at: row.at, lane: row.laneName };
  },

  /** `ade decision-log list` */
  async list() {
    const rows = await listDecisions(1000);
    return {
      count: rows.length,
      decisions: rows.slice(0, 50).map((row) => ({
        // The key is what `reverseDecision` takes, so a terminal reader can
        // reach the same verb the row menu offers.
        key: row.key,
        text: row.value.text,
        lane: row.value.laneName,
        at: row.value.at,
        status: row.value.status,
      })),
    };
  },

  /** `ade decision-log digest` — the same summary the schedule sends. */
  async digest() {
    return exports.actions.weeklyDigest();
  },
};

/** Flip one decision's status, keeping it in the log either way. */
async function setReversed(args, reversed) {
  const key = args && typeof args.key === "string" ? args.key : null;
  if (!key) return { ok: false, message: "That decision could not be identified." };
  const current = await sdk.collections.get("decisions", key);
  if (!current) return { ok: false, message: "That decision is no longer in the log." };

  const next = buildRow({
    key,
    text: current.text,
    at: current.at,
    laneId: current.laneId,
    laneName: current.laneName,
    status: reversed ? "reversed" : "active",
  });
  const stored = await safePut("decisions", key, next);
  if (!stored) return { ok: false, message: "Could not update that decision." };
  await afterChange();
  return { message: reversed ? "Marked as reversed." : "Reversal undone." };
}
