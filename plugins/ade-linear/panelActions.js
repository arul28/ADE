// Every verb a Linear panel can press.
//
// `panels.js` decides what a reader SEES; this module decides what happens when
// they touch it. The two are separate files because they fail differently: a
// builder is pure and a bad one draws the wrong thing, while a handler awaits
// the network and a bad one changes the wrong thing. Keeping them apart is what
// lets the builders be tested with no host at all.
//
// ## The shape of a handler
//
// Every handler takes the flat `args` frame the host dispatches and returns one
// of the vocabulary's action results, or nothing:
//
// - `{navigate: {panelId, context}}` — go to another panel. On iOS this PUSHES,
//   so the client's own back gesture restores the filters, the ticks, the folded
//   sections and the scroll of the panel left behind.
// - `{prompt: {id, title, placeholder, submitLabel, context}}` — ask one
//   question. The client draws it in its own chrome and invokes the SAME action
//   again with `args.prompt = {id, text, context}`, which is why one handler can
//   ask and answer without keeping state between its two calls.
// - `{openUrl}` — `https:` only, opened through the opener that logs this
//   plugin's id.
// - `{authSession: {sessionId}}` — ADE runs the declared OAuth flow. The plugin
//   never writes the URL; the host stamps it.
// - `{resetState: [...]}` — clear named panel-state keys. The only way a plugin
//   can move a control, because panel state belongs to the client.
// - `{message, ok}` — a line of feedback and nothing else.
//
// ## What `bind` is for
//
// The handlers need the SDK, the Linear client, the data layer and the flows,
// and none of those exist at require time. `bind(host)` closes over them once
// and returns the table `index.js` spreads into `exports.actions` — so this
// module imports nothing from `index.js` and the dependency runs one way.
//
// ## Optional host capabilities
//
// `host.publish` and `host.model` are REQUIRED. Everything else this module
// touches is optional and guarded: a handler whose capability is missing still
// returns a valid result — a message saying what it could not do — rather than
// throwing inside the plugin host and leaving the reader on a screen that did
// not move. The full list is {@link HOST_CAPABILITIES}, which
// `panelActions.test.js` asserts against so a rename on either side is a failing
// test rather than a dead button.

"use strict";

const {
  ACTIONS,
  PANEL_ISSUE,
  PANEL_ISSUES,
  PANEL_LAUNCH,
  PANEL_SETTINGS,
  PROMPT_COMMENT,
  PROMPT_SEARCH,
  STATE_ASSIGNEE,
  STATE_BATCH,
  STATE_PRESET,
  STATE_PRIORITY,
  STATE_PROJECT,
  STATE_SORT,
  STATE_TEAM,
  STATE_UPDATED,
} = require("./panels/contract");

const { COPY } = require("./panels/common");
const { issueIdFromRowKey } = require("./panels/rows");

/**
 * Everything a handler may reach for on the host, by path.
 *
 * Written down because "the button does nothing" is the failure mode a plugin
 * cannot see from the outside: a handler calling `host.data.loadIssue` when the
 * data layer named it `fetchIssue` would guard, fall through and return a
 * polite message forever. The test pins this list against the real host object,
 * so the rename fails the build instead.
 */
const HOST_CAPABILITIES = Object.freeze({
  required: ["publish", "model"],
  optional: [
    "data.reload",
    "data.setFilters",
    "data.search",
    "data.loadIssue",
    "data.loadComments",
    "api.setIssueState",
    "api.setIssuePriority",
    "api.assignIssue",
    "api.createComment",
    "flows.createLaneFromIssue",
    "flows.spawnAgentOnIssue",
    "flows.linkIssueToLane",
    "flows.openLaunch",
    "flows.connectOAuth",
    "flows.connectApiKey",
    "flows.adoptHandoff",
    "flows.disconnect",
    "flows.applySettings",
    "flows.createAutolink",
    "sdk.clipboard.write",
  ],
});

/** The state keys `Reset filters` clears. `view` is deliberately not among them. */
const FILTER_STATE_KEYS = [
  STATE_PRESET,
  STATE_PROJECT,
  STATE_ASSIGNEE,
  STATE_PRIORITY,
  STATE_SORT,
  STATE_TEAM,
  STATE_UPDATED,
];

/* ── Reading the frame ──────────────────────────────────────────────────── */

/** A dotted path on the host, or `null`. Never throws on a missing branch. */
function capability(host, path) {
  let node = host;
  for (const step of path.split(".")) {
    if (!node || typeof node !== "object") return null;
    node = node[step];
  }
  return typeof node === "function" ? node : null;
}

/**
 * Call an optional capability, or say it is not there.
 *
 * The `fallback` message is the reader's whole experience of a host that has
 * not implemented the verb yet, so it names what did not happen rather than
 * apologising in the abstract.
 */
async function invoke(host, path, args, fallback) {
  const fn = capability(host, path);
  if (!fn) return { ok: false, message: fallback };
  try {
    const value = await fn.apply(null, args);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
}

function errorText(error) {
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  const text = String(error ?? "").trim();
  return text || "Linear did not answer.";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * The issue this invocation is about.
 *
 * Four places carry one, and a handler is reached from all four: a button's
 * declared `args`, the panel's own navigation `context`, a bound row's key, and
 * a bulk bar's `selection`. Reading them in that order is what lets one handler
 * serve a detail button, a row action AND a batch.
 */
function issueIdFrom(args) {
  const frame = args && typeof args === "object" ? args : {};
  const context = frame.context && typeof frame.context === "object" ? frame.context : {};
  const selection = Array.isArray(frame.selection) ? frame.selection : [];
  // Through `issueIdFromRowKey` because a tick carries the row's key, and a row
  // that declared none inherits its COLLECTION key — which encodes sort order
  // (`flat:000012:<id>`). Creating a lane for `flat:000012:…` is the one failure
  // here worth two defences: `rows.js` declares `key` and this strips it anyway.
  return issueIdFromRowKey(firstString(frame.issueId, frame.key, context.issueId, selection[0]));
}

/** Every issue a batch verb was pressed on, or the single one a row carried. */
function issueIdsFrom(args) {
  const frame = args && typeof args === "object" ? args : {};
  const selection = Array.isArray(frame.selection)
    ? frame.selection.map((entry) => issueIdFromRowKey(firstString(entry))).filter(Boolean)
    : [];
  if (selection.length > 0) return selection;
  const single = issueIdFrom(args);
  return single ? [single] : [];
}

/** The answer to a `{prompt}` this handler asked, when this call is the reply. */
function promptAnswer(args, id) {
  const prompt = args && typeof args === "object" ? args.prompt : null;
  if (!prompt || typeof prompt !== "object") return null;
  if (prompt.id !== id) return null;
  return typeof prompt.text === "string" ? prompt.text : "";
}

/** `{n} issues`, said once so eleven handlers do not each get it wrong. */
function countLabel(count, singular = "issue") {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/* ── The table ──────────────────────────────────────────────────────────── */

/**
 * Close over the host and return every handler a panel schema names.
 *
 * The three refresh ids — `refreshIssues`, `refreshIssue`, `refreshConnection` —
 * are deliberately NOT here. They belong to `index.js`, which owns the fetch and
 * the cache; a schema names them on a Retry button and on each panel's
 * `refreshAction`, and this module reaches them only by navigating.
 */
function bind(host) {
  if (!host || typeof host.publish !== "function" || typeof host.model !== "function") {
    throw new TypeError("panelActions.bind(host) needs a host with publish() and model()");
  }

  /** Publish a panel, swallowing a failure: a redraw is never worth a crash. */
  const publish = async (panelId) => {
    try {
      await host.publish(panelId);
    } catch {
      /* The next action republishes. A reader sees stale words, not an error. */
    }
  };

  const connection = () => {
    const model = host.model() ?? {};
    return model.connection && typeof model.connection === "object" ? model.connection : {};
  };

  /**
   * Every write goes through here.
   *
   * One place decides what a write does when it fails, and the decision is:
   * republish anyway. A control that moved optimistically is a control showing
   * the reader's intention rather than the truth, and the panel is the only
   * thing that can put it back.
   */
  const write = async (path, args, fallback, success) => {
    const result = await invoke(host, path, args, fallback);
    await publish(PANEL_ISSUE);
    await publish(PANEL_ISSUES);
    return result.ok ? { message: success } : { message: result.message, ok: false };
  };

  const handlers = {
    /* ── Navigation ─────────────────────────────────────────────────────── */

    /**
     * A row's press, the smart-link chip's destination, and the palette's.
     *
     * The fetch is awaited before the navigation returns, so the reader lands on
     * the issue rather than on a loading card that becomes the issue — the
     * round trip is happening either way and doing it first spends no extra
     * time. A fetch that fails still navigates: `buildIssuePanel` draws the "not
     * found" body, which carries the way back.
     */
    async openIssue(args) {
      const issueId = issueIdFrom(args);
      if (!issueId) return { navigate: { panelId: PANEL_ISSUES } };
      await invoke(host, "data.loadIssue", [issueId], "");
      await publish(PANEL_ISSUE);
      return { navigate: { panelId: PANEL_ISSUE, context: { issueId } } };
    },

    /** A sub-issue row. The same trip, from a panel that is already the detail. */
    async openSubIssue(args) {
      return await handlers.openIssue(args);
    },

    /**
     * The way back, for the surfaces that have no chrome of their own.
     *
     * Every client that pushes gives the reader a back gesture, so this is not
     * the ordinary path — it is what the detail panel's error bodies offer, and
     * what a deeplink into a missing issue falls out to.
     */
    async backToIssues() {
      return { navigate: { panelId: PANEL_ISSUES } };
    },

    /** The gear on the list, and the sign-in prompt's second button. */
    async openSettings() {
      await publish(PANEL_SETTINGS);
      return { navigate: { panelId: PANEL_SETTINGS } };
    },

    /* ── Filters and search ─────────────────────────────────────────────── */

    /**
     * A filter control moved.
     *
     * Four of the seven controls filter on the client and do not reach here at
     * all. The three that do — the state preset, the sort and the view — change
     * which rows exist or which order they are written in, so this refetches and
     * republishes. The control's own value arrives in `args` under its state key.
     */
    async applyFilters(args) {
      const frame = args && typeof args === "object" ? args : {};
      const patch = {};
      for (const key of FILTER_STATE_KEYS) {
        if (frame[key] !== undefined) patch[key] = frame[key];
      }
      if (typeof frame.value === "string") patch.value = frame.value;
      const result = await invoke(host, "data.setFilters", [patch], "");
      await publish(PANEL_ISSUES);
      return result.ok ? undefined : { message: result.message, ok: false };
    },

    /**
     * The desktop's own `Reset filters`, and the empty state's way out.
     *
     * `{resetState}` is the only thing that can move a control: panel state is
     * per-viewer and lives on the client, so a plugin republishing a schema with
     * different defaults would not touch a control the reader has already
     * touched. The `view` key is left alone on purpose — which layout somebody
     * is reading in is not a filter, and resetting it would move the panel out
     * from under them.
     */
    async clearFilters() {
      await invoke(host, "data.setFilters", [{ reset: true }], "");
      await publish(PANEL_ISSUES);
      return { resetState: FILTER_STATE_KEYS, message: "Filters reset." };
    },

    /**
     * Search, as a question rather than as a field.
     *
     * The vocabulary has no search node, so the first call asks and the second
     * one — the same handler, re-invoked by the client with the answer — runs
     * the search. An empty answer is a cleared search rather than a search for
     * nothing, which is what a reader who wiped the field meant.
     */
    async searchIssues(args) {
      const answer = promptAnswer(args, PROMPT_SEARCH);
      if (answer === null) {
        return {
          prompt: {
            id: PROMPT_SEARCH,
            title: COPY.searchTitle,
            placeholder: COPY.searchPlaceholder,
            submitLabel: COPY.searchSubmit,
          },
        };
      }
      const text = answer.trim();
      const result = await invoke(host, "data.search", [text], "Search needs the plugin's data layer.");
      await publish(PANEL_ISSUES);
      if (!result.ok) return { message: result.message, ok: false };
      return { message: text ? `Searching for “${text}”.` : "Search cleared." };
    },

    /** The badge's companion, and the only way out of a search on a phone. */
    async clearSearch() {
      const result = await invoke(host, "data.search", [""], "Search needs the plugin's data layer.");
      await publish(PANEL_ISSUES);
      return result.ok ? { message: "Search cleared." } : { message: result.message, ok: false };
    },

    /* ── Launching work ─────────────────────────────────────────────────── */

    /**
     * A lane and an agent, for one issue or for a selection of them.
     *
     * The batch is sequential rather than parallel. Creating eleven lanes at
     * once means eleven worktrees and eleven agent processes starting in the
     * same second on one machine, and the built-in's own batch launcher walks
     * them for the same reason. The count is reported whole at the end, with the
     * failures named — a batch that half-worked and said "done" is the report a
     * reader cannot act on.
     */
    async launchLaneAndAgent(args) {
      return await runLaunch(args, false);
    },

    /** The same walk, stopping at the lane. */
    async launchLaneOnly(args) {
      return await runLaunch(args, true);
    },

    /**
     * Attach an issue to a lane that already exists.
     *
     * A verb the built-in has on neither surface. It is a row action and a bulk
     * action because the case it exists for is the one the conflict badge
     * announces: the issue already has a lane, and what the reader wants is the
     * link, not a twelfth worktree.
     */
    async linkToLane(args) {
      const ids = issueIdsFrom(args);
      if (ids.length === 0) return { message: "Pick an issue first.", ok: false };
      const result = await invoke(
        host,
        "flows.linkIssueToLane",
        [ids],
        "Linking an issue to a lane is not available in this ADE build.",
      );
      await publish(PANEL_ISSUES);
      await publish(PANEL_ISSUE);
      if (!result.ok) return { message: result.message, ok: false };
      return { resetState: [STATE_BATCH], message: `Linked ${countLabel(ids.length)}.` };
    },

    /**
     * The launch FORM, when the manifest has a panel to draw it in.
     *
     * `flows.openLaunch` is the switch: while `plugin.json` declares no `launch`
     * panel, navigating to one would send the reader to a panel id the host
     * cannot resolve. So the capability is the manifest's proxy, and without it
     * the two buttons above do the work directly with the plugin's defaults.
     */
    async openLaunch(args) {
      const issueId = issueIdFrom(args);
      if (!issueId) return { message: "Pick an issue first.", ok: false };
      const laneOnly = args?.laneOnly === true || args?.laneOnly === "true";
      const result = await invoke(host, "flows.openLaunch", [issueId, { ...args, laneOnly }], "");
      // No `flows.openLaunch` means no `launch` panel in the manifest, and
      // navigating to a panel id the host cannot resolve would leave the reader
      // nowhere. So the button does what it says instead, with the defaults —
      // which is exactly what it did before the panel existed.
      if (!result.ok) {
        return laneOnly ? await handlers.launchLaneOnly(args) : await handlers.launchLaneAndAgent(args);
      }
      await publish(PANEL_LAUNCH);
      return { navigate: { panelId: PANEL_LAUNCH, context: { issueId, laneOnly } } };
    },

    /** The launch form's submit. Inert for the same reason as `openLaunch`. */
    async submitLaunch(args) {
      const issueId = issueIdFrom(args);
      if (!issueId) return { message: "Pick an issue first.", ok: false };
      const laneOnly = args?.sessionType === "laneOnly";
      const result = await invoke(
        host,
        laneOnly ? "flows.createLaneFromIssue" : "flows.spawnAgentOnIssue",
        [issueId, args],
        "Launching is not available in this ADE build.",
      );
      await publish(PANEL_ISSUES);
      if (!result.ok) return { message: result.message, ok: false };
      return { navigate: { panelId: PANEL_ISSUES }, message: laneOnly ? "Lane created." : "Agent started." };
    },

    /* ── Writing back to Linear ─────────────────────────────────────────── */

    /**
     * Assign one issue, or a selection, to the person holding the credential.
     *
     * The viewer id comes from the connection rather than from the caller: an
     * assignee id in an action payload would be a payload that can assign an
     * issue to anybody, and nothing on this panel needs that.
     */
    async assignToMe(args) {
      const ids = issueIdsFrom(args);
      if (ids.length === 0) return { message: "Pick an issue first.", ok: false };
      const viewerId = connection().viewerId;
      if (!viewerId) return { message: "Connect Linear first.", ok: false };

      const failures = [];
      for (const issueId of ids) {
        const result = await invoke(host, "api.assignIssue", [issueId, viewerId], "Assigning needs a connection.");
        if (!result.ok) failures.push(result.message);
      }
      await invoke(host, "data.reload", [], "");
      await publish(PANEL_ISSUES);
      await publish(PANEL_ISSUE);
      if (failures.length > 0) {
        return { message: `Assigned ${countLabel(ids.length - failures.length)}. ${failures[0]}`, ok: false };
      }
      return { resetState: [STATE_BATCH], message: `Assigned ${countLabel(ids.length)} to you.` };
    },

    /**
     * The detail panel's state control moved.
     *
     * What a control hands its handler is the panel's STATE MAP, where the new
     * value sits under a key naming the issue — so this reads whichever key it
     * was given rather than guessing at a name it would have to keep in step
     * with the builder. That is why the automation step of the same sentence
     * lives behind `stepSetIssueState` in the data half: it reads
     * `{issueId, stateId}`, which a `segmented` cannot produce. Both paths end
     * in the same `api.setIssueState` call, so a rule and a control cannot
     * drift — they only enter through different doors.
     */
    async setIssueState(args) {
      const issueId = issueIdFrom(args);
      const stateId = readChangedValue(args, "issueState:");
      if (!issueId || !stateId) return { message: "That state could not be read.", ok: false };
      return await write("api.setIssueState", [issueId, stateId], "Changing state needs a connection.", "State updated.");
    },

    /** The same shape, for priority. `0` is a real value and must survive. */
    async setIssuePriority(args) {
      const issueId = issueIdFrom(args);
      const priority = readChangedValue(args, "issuePriority:");
      if (!issueId || priority === null) return { message: "That priority could not be read.", ok: false };
      return await write(
        "api.setIssuePriority",
        [issueId, Number(priority)],
        "Changing priority needs a connection.",
        "Priority updated.",
      );
    },

    /**
     * Write a comment.
     *
     * Ask, then post — the same two-call shape as the search. One line, because
     * `{prompt}` is one field on every client and the vocabulary has no
     * multi-line composer; a reader who wants a paragraph writes it in Linear,
     * and the report says so rather than pretending otherwise.
     *
     * The automation step of the same sentence lives behind `stepCommentOnIssue`
     * in the data half, because it reads `{issueId, body}` and would throw "A
     * comment needs a body." on the first press — which is exactly the press
     * that is supposed to ask the question.
     */
    async commentOnIssue(args) {
      const issueId = issueIdFrom(args);
      if (!issueId) return { message: "Pick an issue first.", ok: false };

      const answer = promptAnswer(args, PROMPT_COMMENT);
      if (answer === null) {
        return {
          prompt: {
            id: PROMPT_COMMENT,
            title: COPY.commentTitle,
            placeholder: COPY.commentPlaceholder,
            submitLabel: COPY.commentSubmit,
            context: { issueId },
          },
        };
      }
      const body = answer.trim();
      if (!body) return { message: "Nothing to post." };

      const result = await invoke(host, "api.createComment", [issueId, body], "Commenting needs a connection.");
      if (result.ok) await invoke(host, "data.loadComments", [issueId, { all: false }], "");
      await publish(PANEL_ISSUE);
      return result.ok ? { message: "Comment posted." } : { message: result.message, ok: false };
    },

    /**
     * Widen the comment window.
     *
     * The detail panel draws as many comments as its node and byte budgets
     * allow and says how many it dropped; this asks the plugin for the whole
     * thread and republishes. The built-in pages comments on neither surface, so
     * this is an addition rather than a port.
     */
    async loadComments(args) {
      const issueId = issueIdFrom(args);
      if (!issueId) return { message: "Pick an issue first.", ok: false };
      const result = await invoke(host, "data.loadComments", [issueId, { all: true }], "Comments need a connection.");
      await publish(PANEL_ISSUE);
      return result.ok ? undefined : { message: result.message, ok: false };
    },

    /**
     * Out to Linear itself.
     *
     * `https:` only on every client, and the URL comes from the row or the
     * button rather than being assembled here — an issue's canonical URL is
     * Linear's to decide and the plugin already stored the one it was given.
     */
    async openInLinear(args) {
      const url = firstString(args?.url, args?.context?.url);
      if (url) return { openUrl: url };
      const model = host.model() ?? {};
      const issueUrl = firstString(model.issue?.url);
      if (issueUrl) return { openUrl: issueUrl };
      return { message: "That issue has no Linear URL yet.", ok: false };
    },

    /**
     * An `https:` link that is not an issue.
     *
     * `openInLinear` cannot serve this: the DATA half owns that id and answers
     * it by looking up a stored issue row, so a settings link to
     * `linear.app/settings/api` would be answered with "That issue has no Linear
     * link." One id per shape is the smaller of the two evils.
     */
    async openExternal(args) {
      const url = firstString(args?.url, args?.context?.url);
      return url ? { openUrl: url } : { message: "That link is missing.", ok: false };
    },

    /* ── The connection ─────────────────────────────────────────────────── */

    /**
     * Sign in.
     *
     * The plugin names the flow and nothing else: `authSessions[0].id` in the
     * manifest is `linear`, the host stamps the URL and the transport, and the
     * plugin never sees a client secret. That is the whole reason this is one
     * line — a plugin that built its own authorize URL would be a plugin that
     * could point one somewhere else.
     */
    async connectOAuth() {
      const result = await invoke(host, "flows.connectOAuth", [], "");
      if (result.ok && result.value) return result.value;
      return { authSession: { sessionId: "linear" } };
    },

    /**
     * The API-key path.
     *
     * The key arrives in the form's values map under `apiKey`, from a `secret`
     * field — masked on every client, which a `{prompt}` is not. Nothing here
     * logs it, echoes it into a message, or puts it in a panel.
     */
    async connectApiKey(args) {
      const key = typeof args?.apiKey === "string" ? args.apiKey.trim() : "";
      if (!key) return { message: "Paste a Linear API key first.", ok: false };
      const result = await invoke(host, "flows.connectApiKey", [key], "Connecting needs the plugin's data layer.");
      await publish(PANEL_SETTINGS);
      await publish(PANEL_ISSUES);
      return result.ok ? { message: "Connected to Linear." } : { message: result.message || COPY.apiKeyRejected, ok: false };
    },

    /**
     * Take the connection ADE already holds.
     *
     * Offered once per install. ADE asks the user first and names exactly what
     * moves, so a declined handoff is an answer rather than an error and the
     * ordinary sign-in is still on the same screen.
     */
    async adoptHandoff() {
      const result = await invoke(host, "flows.adoptHandoff", [], "This ADE build has no connection to hand over.");
      await publish(PANEL_SETTINGS);
      await publish(PANEL_ISSUES);
      if (!result.ok) return { message: result.message, ok: false };
      return { message: result.value === false ? "ADE kept the connection." : "Connected to Linear." };
    },

    /** Forget the credential on this machine. The button asks first. */
    async disconnect() {
      const result = await invoke(host, "flows.disconnect", [], "Disconnecting needs the plugin's data layer.");
      await publish(PANEL_SETTINGS);
      await publish(PANEL_ISSUES);
      return result.ok ? { message: "Disconnected from Linear." } : { message: result.message, ok: false };
    },

    /**
     * A preference changed.
     *
     * `applyOnChange` sends the WHOLE values map on every committed edit, so
     * this is idempotent by construction and there is no Apply button to hunt
     * for. It republishes because a rejected value must end up back on screen as
     * the value that was actually stored.
     */
    async applySettings(args) {
      const values = args && typeof args === "object" ? { ...args } : {};
      delete values.selection;
      delete values.context;
      delete values.prompt;
      const result = await invoke(host, "flows.applySettings", [values], "Settings need the plugin's data layer.");
      await publish(PANEL_SETTINGS);
      return result.ok ? undefined : { message: result.message, ok: false };
    },

    /** One GitHub autolink, from the row that names its prefix. */
    async createAutolink(args) {
      const prefix = firstString(args?.prefix);
      if (!prefix) return { message: "That reference has no prefix.", ok: false };
      const result = await invoke(host, "flows.createAutolink", [prefix], "GitHub autolinks need a connected repo.");
      await publish(PANEL_SETTINGS);
      return result.ok ? { message: `Added ${prefix} references.` } : { message: result.message, ok: false };
    },

    /**
     * The webhook URL, onto the clipboard.
     *
     * The URL is drawn on the panel as `code` too, because a copy that silently
     * fails on a surface with no clipboard would leave a reader with no way to
     * get the string at all.
     */
    async copyWebhookUrl() {
      const model = host.model() ?? {};
      const url = firstString(model.ingress?.url, model.connection?.webhookUrl);
      if (!url) return { message: "No webhook URL yet.", ok: false };
      const result = await invoke(host, "sdk.clipboard.write", [url], "This surface has no clipboard.");
      return result.ok ? { message: "Webhook URL copied." } : { message: result.message, ok: false };
    },
  };

  return handlers;

  /**
   * The shared body of the two launch verbs.
   *
   * Declared after the table it is used from, which is legal for a function
   * declaration and is where it reads best: the table is what a reader of this
   * file came for.
   */
  async function runLaunch(args, laneOnly) {
    const ids = issueIdsFrom(args);
    if (ids.length === 0) return { message: "Pick an issue first.", ok: false };

    const path = laneOnly ? "flows.createLaneFromIssue" : "flows.spawnAgentOnIssue";
    const failures = [];
    let done = 0;
    for (const issueId of ids) {
      const result = await invoke(host, path, [issueId, args], "Launching is not available in this ADE build.");
      if (result.ok) done += 1;
      else failures.push(result.message);
    }

    await invoke(host, "data.reload", [], "");
    await publish(PANEL_ISSUES);
    await publish(PANEL_ISSUE);

    const noun = laneOnly ? "lane" : "agent";
    if (failures.length > 0) {
      return {
        message: `Started ${countLabel(done, noun)}. ${failures.length} failed: ${failures[0]}`,
        ok: false,
      };
    }
    return { resetState: [STATE_BATCH], message: `Started ${countLabel(done, noun)}.` };
  }
}

/**
 * The value a `segmented` with a per-issue state key just changed to.
 *
 * The detail panel keys its two controls on the issue's identifier, so the
 * handler cannot know the key's full name in advance. It reads whichever key in
 * the frame starts with the control's prefix — which is exactly one, because a
 * panel draws one issue — and falls back to the flat `value` some clients send
 * beside it.
 */
function readChangedValue(args, prefix) {
  const frame = args && typeof args === "object" ? args : {};
  for (const [key, value] of Object.entries(frame)) {
    if (key.startsWith(prefix) && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  return firstString(frame.value, frame.stateValue);
}

module.exports = { ACTIONS, FILTER_STATE_KEYS, HOST_CAPABILITIES, bind, readChangedValue };
