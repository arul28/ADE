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
// touches is optional and guarded through {@link invoke}: a handler whose
// capability is missing still returns a valid result — a message saying what it
// could not do — rather than throwing inside the plugin host and leaving the
// reader on a screen that did not move.
//
// Each one is named where it is called (`host.flows?.openLaunch`) rather than in
// a table of dotted strings walked at run time. The table existed to make a
// misspelling fail a test; naming the property directly makes it fail to
// resolve, which is the same guarantee without a second list to keep in step.

"use strict";

const {
  ACTIONS,
  PANEL_ISSUE,
  PANEL_ISSUES,
  PANEL_LAUNCH,
  PANEL_SETTINGS,
  PROMPT_COMMENT,
  PROMPT_LANE,
  PROMPT_SEARCH,
  SETTINGS_SECTION_SOCKET_ID,
  STATE_ASSIGNEE,
  STATE_BATCH,
  STATE_PRESET,
  STATE_PRIORITY,
  STATE_PROJECT,
  STATE_SEARCH,
  STATE_SORT,
  STATE_TEAM,
  STATE_UPDATED,
} = require("./panels/contract");

const { COPY } = require("./panels/common");
const { issueIdFromRowKey } = require("./panels/rows");

/** The state keys `Reset filters` clears. Search is among them; ticks are not. */
const FILTER_STATE_KEYS = [
  STATE_PRESET,
  STATE_PROJECT,
  STATE_ASSIGNEE,
  STATE_PRIORITY,
  STATE_SORT,
  STATE_TEAM,
  STATE_UPDATED,
  STATE_SEARCH,
];

/**
 * The state keys a filter change CARRIES: the reset list minus search.
 *
 * Search goes through `searchIssues`, not `setFilters`, so a segmented change
 * must not rewrite the query.
 */
const APPLIED_STATE_KEYS = FILTER_STATE_KEYS.filter((key) => key !== STATE_SEARCH);

/* ── Reading the frame ──────────────────────────────────────────────────── */

/**
 * Call an optional host capability, or say it is not there.
 *
 * Takes the FUNCTION, not a dotted string naming it. There was a `capability()`
 * that walked `"flows.openLaunch"` over the host object, and a frozen table of
 * the twenty paths it was allowed to walk, pinned by a test — an elaborate
 * defence for a lookup with exactly ONE host (`index.js:buildPanelHost`, which
 * writes all twenty). `host.flows?.openLaunch` is checked by the reader's own
 * editor, greps to its definition, and cannot be misspelled into a handler that
 * politely does nothing forever.
 *
 * `missing` and `ok:false` are NOT the same answer, and the difference matters:
 * a capability this build does not have is a reason to do something else, while
 * a capability that THREW is a failure the reader has to be told about. See
 * `openLaunch`, which used to answer both by silently creating a lane.
 *
 * The `fallback` message is the reader's whole experience of a host that has
 * not implemented the verb yet, so it names what did not happen rather than
 * apologising in the abstract.
 */
async function invoke(fn, args, fallback) {
  if (typeof fn !== "function") return { ok: false, missing: true, message: fallback };
  try {
    const value = await fn(...args);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, missing: false, message: errorText(error) };
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
  const write = async (fn, args, fallback, success) => {
    const result = await invoke(fn, args, fallback);
    await publish(PANEL_ISSUE);
    await publish(PANEL_ISSUES);
    return result.ok ? { message: success } : { message: result.message, ok: false };
  };

  const handlers = {
    /* ── Navigation ─────────────────────────────────────────────────────── */

    // No `openIssue` and no `openSubIssue`. Issue navigation is the DATA half's
    // — `contract.js:CORE_OWNED_ACTIONS` says so, and `index.js` merges its
    // handlers in after these, so a copy here would be dead code that reads as
    // the live one. Its version resolves a row KEY or an identifier and falls
    // through to Linear for an issue this project has never listed, which this
    // one could not do: it has no collection to look in.

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

    /**
     * The gear on the list, and the sign-in prompt's second button.
     *
     * TWO verbs, because the destination is genuinely different per client and
     * an action cannot tell which one it is running for. Desktop and the web
     * client host this plugin's connection card as a `settings-section` on
     * ADE's own Settings page, and that is where a reader who presses a gear
     * expects to land — `{openSettings: {socketId}}` names the section rather
     * than a page id, so ADE opens the tab that section resolved to. The phone
     * and the terminal draw no Settings page for a plugin at all, so for them
     * the same press has to stay a navigation to the plugin's own settings
     * panel, which is the only connection screen those two have.
     *
     * A client honours the verb it can and ignores the other. Neither client
     * is left with a dead gear, which is what a single verb would have cost
     * one of them.
     */
    async openSettings() {
      await publish(PANEL_SETTINGS);
      return {
        openSettings: { socketId: SETTINGS_SECTION_SOCKET_ID },
        navigate: { panelId: PANEL_SETTINGS },
      };
    },

    /* ── Filters and search ─────────────────────────────────────────────── */

    /**
     * A filter control moved.
     *
     * Four of the seven controls filter on the client and do not reach here at
     * all. The three that do — the state preset, the sort and the team — change
     * which rows exist or which order they are written in, so this refetches and
     * republishes. The control's own value arrives in `args` under its state key.
     */
    async applyFilters(args) {
      const frame = args && typeof args === "object" ? args : {};
      const patch = {};
      for (const key of APPLIED_STATE_KEYS) {
        if (frame[key] !== undefined) patch[key] = frame[key];
      }
      if (typeof frame.value === "string") patch.value = frame.value;
      const result = await invoke(host.data?.setFilters, [patch], "");
      await publish(PANEL_ISSUES);
      return result.ok ? undefined : { message: result.message, ok: false };
    },

    /**
     * The desktop's own `Reset filters`, and the empty state's way out.
     *
     * `{resetState}` is the only thing that can move a control: panel state is
     * per-viewer and lives on the client, so a plugin republishing a schema with
     * different defaults would not touch a control the reader has already
     * touched. Search is among the keys because a leftover query with empty
     * chips is the thing a reader files a bug about.
     */
    async clearFilters() {
      await invoke(host.data?.setFilters, [{ reset: true }], "");
      await publish(PANEL_ISSUES);
      return { resetState: FILTER_STATE_KEYS, message: "Filters reset." };
    },

    /**
     * Search. The nav-bar field commits `{ q }` on blur and Enter. Hosts that
     * have no chrome field still ask `{prompt}` and re-invoke with the answer.
     * An empty answer is a cleared search rather than a search for nothing,
     * which is what a reader who wiped the field meant.
     */
    async searchIssues(args) {
      const frame = args && typeof args === "object" ? args : {};
      let text = null;
      if (typeof frame[STATE_SEARCH] === "string") {
        text = frame[STATE_SEARCH];
      } else {
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
        text = answer;
      }
      const query = text.trim();
      const result = await invoke(host.data?.search, [query], "Search needs the plugin's data layer.");
      await publish(PANEL_ISSUES);
      if (!result.ok) return { message: result.message, ok: false };
      return { message: query ? `Searching for “${query}”.` : "Search cleared." };
    },

    /** The way out of a search on a host that still draws a Clear button. */
    async clearSearch() {
      const result = await invoke(host.data?.search, [""], "Search needs the plugin's data layer.");
      await publish(PANEL_ISSUES);
      return result.ok
        ? { message: "Search cleared.", resetState: [STATE_SEARCH] }
        : { message: result.message, ok: false };
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
     * Asks which lane when the press did not name one. Taking `lanes[0]` was
     * the reduced answer: a project with two lanes silently linked to the
     * wrong one. The picker is a `{prompt}` with `options`, one hop, same as
     * a comment — the chosen value comes back as `args.prompt.text`.
     */
    async linkToLane(args) {
      const ids = issueIdsFrom(args);
      if (ids.length === 0) return { message: "Pick an issue first.", ok: false };
      const laneId = firstString(args.laneId, promptAnswer(args, PROMPT_LANE));
      const result = await invoke(
        host.flows?.linkIssueToLane,
        [ids, laneId],
        "Linking an issue to a lane is not available in this ADE build.",
      );
      if (result.missing) return { message: result.message, ok: false };
      if (!result.ok) return { message: result.message, ok: false };
      if (result.value && typeof result.value === "object" && result.value.prompt) {
        return { prompt: result.value.prompt };
      }
      await publish(PANEL_ISSUES);
      await publish(PANEL_ISSUE);
      return { resetState: [STATE_BATCH], message: `Linked ${countLabel(ids.length)}.` };
    },

    /**
     * The launch FORM, when this build has a host that can draw it.
     *
     * `flows.openLaunch` is the switch: on a build without it, navigating to the
     * launch panel would send the reader to a panel id the host cannot resolve.
     * So its ABSENCE means "do the work directly with the defaults".
     *
     * A capability that is present and THREW means no such thing, and the two
     * were answered the same way: a transient failure inside `openLaunch` —
     * which awaits a model read and a publish — silently created a worktree and
     * started an agent on the plugin's defaults, for a reader who had pressed a
     * button that says it opens a form. Only `missing` falls through now; a
     * failure is reported, and nothing is created.
     */
    async openLaunch(args) {
      const issueId = issueIdFrom(args);
      if (!issueId) return { message: "Pick an issue first.", ok: false };
      const laneOnly = args?.laneOnly === true || args?.laneOnly === "true";
      const result = await invoke(host.flows?.openLaunch, [issueId, { ...args, laneOnly }], "");
      if (result.missing) {
        return laneOnly ? await handlers.launchLaneOnly(args) : await handlers.launchLaneAndAgent(args);
      }
      if (!result.ok) return { message: result.message, ok: false };
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
        const result = await invoke(host.api?.assignIssue, [issueId, viewerId], "Assigning needs a connection.");
        if (!result.ok) failures.push(result.message);
      }
      await invoke(host.data?.reload, [], "");
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
      return await write(host.api?.setIssueState, [issueId, stateId], "Changing state needs a connection.", "State updated.");
    },

    /** The same shape, for priority. `0` is a real value and must survive. */
    async setIssuePriority(args) {
      const issueId = issueIdFrom(args);
      const priority = readChangedValue(args, "issuePriority:");
      if (!issueId || priority === null) return { message: "That priority could not be read.", ok: false };
      return await write(
        host.api?.setIssuePriority,
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

      const result = await invoke(host.api?.createComment, [issueId, body], "Commenting needs a connection.");
      if (result.ok) await invoke(host.data?.loadComments, [issueId, { all: false }], "");
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
      const result = await invoke(host.data?.loadComments, [issueId, { all: true }], "Comments need a connection.");
      await publish(PANEL_ISSUE);
      return result.ok ? undefined : { message: result.message, ok: false };
    },

    // No `openInLinear` either, for the same reason and by the same rule. Every
    // panel button passes `{issueId}` (`rows.js`, `issue.js`) because the data
    // half answers it from the STORED row's `url` — a copy here that read a
    // `url` argument would be answering a shape no schema sends.

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
     * plugin never sees a client secret. That is the whole reason this is short
     * — a plugin that built its own authorize URL would be a plugin that could
     * point one somewhere else.
     *
     * A FAILURE is reported, never dressed as a start. This used to answer
     * `{authSession: {sessionId: "linear"}}` whatever happened, so a build with
     * no OAuth client, a flow already running, and a host with nothing to show a
     * sign-in window in all produced a button that appeared to work and a
     * browser that never opened. `ade.auth.beginSession` already says which of
     * those it was; the reader is the person who has to act on it.
     */
    async connectOAuth(args) {
      // The panel that drew the button names itself in `args.origin`, and it is
      // the only place that knows: `auth.completed` carries the flow and not
      // the screen, so an origin worked out at completion time would be a
      // guess. A press from a schema that predates this names none, and the
      // data half falls back to the settings panel — see
      // `connect.js:normalizeAuthOrigin`.
      const origin = typeof args?.origin === "string" ? args.origin : null;
      const result = await invoke(
        host.flows?.connectOAuth,
        [origin],
        "Signing in needs the plugin's data layer.",
      );
      if (!result.ok) return { message: result.message, ok: false };
      // The host STAMPED this: `begin` answers `{authSession: {sessionId}}` and
      // the client fills in the live URL from it. Returning our own literal
      // instead would name a flow the host never started.
      if (result.value) return result.value;
      return { message: "Could not start the Linear sign-in.", ok: false };
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
      const result = await invoke(host.flows?.connectApiKey, [key], "Connecting needs the plugin's data layer.");
      await publish(PANEL_SETTINGS);
      await publish(PANEL_ISSUES);
      return result.ok ? { message: "Connected to Linear." } : { message: result.message || COPY.apiKeyRejected, ok: false };
    },

    /** Forget the credential on this machine. The button asks first. */
    async disconnect() {
      const result = await invoke(host.flows?.disconnect, [], "Disconnecting needs the plugin's data layer.");
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
      const result = await invoke(host.flows?.applySettings, [values], "Settings need the plugin's data layer.");
      await publish(PANEL_SETTINGS);
      return result.ok ? undefined : { message: result.message, ok: false };
    },

    /** One GitHub autolink, from the row that names its prefix. */
    async createAutolink(args) {
      const prefix = firstString(args?.prefix);
      if (!prefix) return { message: "That reference has no prefix.", ok: false };
      const result = await invoke(host.flows?.createAutolink, [prefix], "GitHub autolinks need a connected repo.");
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
      const result = await invoke(host.sdk?.clipboard?.write, [url], "This surface has no clipboard.");
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

    const launch = laneOnly ? host.flows?.createLaneFromIssue : host.flows?.spawnAgentOnIssue;
    const failures = [];
    let done = 0;
    for (const issueId of ids) {
      const result = await invoke(launch, [issueId, args], "Launching is not available in this ADE build.");
      if (result.ok) done += 1;
      else failures.push(result.message);
    }

    await invoke(host.data?.reload, [], "");
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

module.exports = { ACTIONS, APPLIED_STATE_KEYS, FILTER_STATE_KEYS, bind, readChangedValue };
