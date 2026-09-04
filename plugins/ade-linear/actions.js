// The plugin's own action handlers — everything the MANIFEST dispatches.
//
// One file for one responsibility. `index.js` is the lifecycle: activate, the
// subscriptions, the reads, and the single `viewFor` mapper that shapes every
// panel. This is the table the host calls into by id — the nine agent tools,
// the four automation steps, the search provider, the sockets, the CLI word,
// and the chat header's two Linear verbs.
//
// ## Why a factory, and why `deps.data` rather than `data`
//
// `index.js` holds its collaborators in module-level bindings that are null
// until `activate` runs and null again after `deactivate`. A handler that
// captured one at build time would hold the null. So every use goes through
// `deps`, which is read at the moment the button is pressed — which is the only
// moment the answer is known.
//
// The table itself is built ONCE at load, so `exports.actions` resolves every
// declared id before the first `activate`: a tool call can arrive before it
// finishes, and "no such action" for a declared tool reads to the model as a
// broken tool rather than as a plugin still starting.
//
// ## The one invariant
//
// This table and `panelActions.js`'s are DISJOINT — no id is defined by both,
// and `test/index.test.js` asserts it. Before that, a merge order decided
// collisions silently, and three handlers read as live while being unreachable.

"use strict";

const { isMissingTokenError } = require("./linearApi");

/**
 * Build the action table.
 *
 * `deps` carries the lifecycle's live bindings — `sdk`, `data`, `flows`,
 * `connect`, `automation`, each read through a getter — plus the handful of
 * things this table needs from the lifecycle itself.
 */
function createOwnActions(deps) {
  const { publish, refreshIssues, ensureIssues, webhooksReachable, issueIdFromRowKey } = deps;

  /** One sentence for a chat with no Linear issue behind it. Said in two places. */
  const NO_ISSUE_FOR_CHAT = "This chat has no Linear issue attached.";

  /**
   * The Linear issue behind whatever the reader pressed from.
   *
   * Three contexts reach the two chat-header verbs, and only one of them was
   * handled. The `chat-header-action` socket sends a `PluginSessionContext` —
   * `{kind: "session", id, title, provider, status}` — and NOTHING else: no
   * `laneId`, because a session context does not carry one. So the `lane` and
   * `composer` branches never matched, `args.laneId` was always undefined, and
   * `openSessionIssue` answered "no issue attached" for every chat in every lane
   * while `commentProgress` fell back to `rows[0]` and commented on a stranger's
   * ticket.
   *
   * A session is mapped to its lane by asking the host which sessions each lane
   * holds. That is one extra read per press, on a button a reader presses by
   * hand, and it is the only thing on this machine that knows the answer.
   */
  async function issueLinkForContext(args) {
    const context = args?.context && typeof args.context === "object" ? args.context : {};
    const { rows } = await deps.data.laneIndex();
    const linkFor = (laneId) => (laneId ? rows.find((row) => row.laneId === laneId) ?? null : null);

    // A lane or a composer names its lane outright.
    const named = context.kind === "lane"
      ? context.id
      : args?.laneId ?? (context.kind === "composer" ? context.laneId : null);
    if (named) return linkFor(named);

    const sessionId = context.kind === "session" ? context.id : args?.sessionId ?? null;
    if (!sessionId) return null;

    // The session's own issue links first: a chat can carry one directly, and
    // that is a better answer than its lane's when the two differ.
    for (const row of rows) {
      let groups = [];
      try {
        groups = await deps.flows.sessionIssues(row.laneId);
      } catch {
        groups = [];
      }
      for (const group of Array.isArray(groups) ? groups : []) {
        if (String(group?.sessionId ?? "") !== String(sessionId)) continue;
        const linked = (Array.isArray(group?.issueLinks) ? group.issueLinks : [])
          .map((entry) => entry?.issue)
          .find((issue) => issue?.provider === "linear" && issue?.issueId);
        if (linked) {
          return { laneId: row.laneId, laneName: row.laneName, issueId: linked.issueId, issueKey: linked.key ?? null };
        }
        // The session is in THIS lane; the lane's own issue is the answer.
        return linkFor(row.laneId);
      }
    }

    // A host that cannot say which lane holds the session, or a chat in a lane
    // with no Linear issue. Both are honestly "there is no issue here" — never
    // "here is somebody else's".
    return null;
  }

  /** One sentence for whatever Linear refused, worded for a banner. */
  function failureMessage(error, fallback) {
    if (isMissingTokenError(error)) return "Connect Linear in Settings → Linear.";
    return error?.message ?? fallback;
  }

  /**
   * The action table.
   *
   * `panelActions.bind(host)` RETURNS the panel half's handler table — there is
   * no `panelActions.actions` export to spread, and `{...undefined}` is legal, so
   * reaching for one would have registered nothing and thrown nowhere. `activate`
   * assigns the returned table and then re-applies this one over it, which is
   * what keeps the three refresh ids the data half's: `plugin.json` names them on
   * `refreshAction` and this half is what performs them.
   */
  const ownActions = {
    /* ── Refresh, named by the manifest's `refreshAction` fields ─────────── */

    /** The issue panel's refresh gesture, the empty state's retry, and the CLI's. */
    async refreshIssues(args) {
      const result = await refreshIssues({ ...(args?.limit ? { limit: args.limit } : {}) });
      if (result.state === "no-token") return { message: "Connect Linear in Settings → Linear.", ok: false };
      if (result.state === "error") return { message: result.error, ok: false };
      return { message: `${result.count ?? 0} ${result.count === 1 ? "issue" : "issues"}.` };
    },

    /** The detail panel's refresh gesture. */
    async refreshIssue(args) {
      const issueId = args?.issueId ?? args?.context?.issueId ?? null;
      if (!issueId) return { navigate: { panelId: "issues" } };
      const result = await deps.data.refreshIssue(issueId);
      await publish("issue", { issueId });
      if (!result.ok) return { message: result.error, ok: false };
      return { message: null };
    },

    /** The settings section's refresh gesture. */
    async refreshConnection() {
      const connection = await deps.data.refreshConnection();
      await publish("settings");
      if (!connection.connected && connection.lastError) return { message: connection.lastError, ok: false };
      return { message: connection.connected ? `Connected as ${connection.viewerName ?? "you"}.` : null };
    },

    /* ── Agent tools ─────────────────────────────────────────────────────── */
    //
    // A tool THROWS on failure rather than answering `{ok:false}`. The host turns
    // a thrown error into a tool error the model can read and react to; a
    // successful-looking result carrying a failure is one the model reports to
    // the user as done.

    getIssueTool: (args) => deps.automation.getIssue(args),
    searchIssuesTool: (args) => deps.automation.searchIssues(args),
    addCommentTool: (args) => deps.automation.addComment(args),
    updateIssueStateTool: (args) => deps.automation.updateIssueState(args),
    listStatesTool: (args) => deps.automation.listStates(args),
    assignIssueTool: (args) => deps.automation.assignIssue(args),
    addLabelTool: (args) => deps.automation.addLabel(args),
    createLaneForIssueTool: (args) => deps.automation.createLaneForIssue(args),
    graphqlTool: (args) => deps.automation.graphql(args),

    /* ── Automation steps ────────────────────────────────────────────────── */
    //
    // Prefixed `step`, because `setIssueState`, `commentOnIssue` and
    // `assignIssue` are also PANEL action ids in `panels/contract.js` and the two
    // callers want different things from the same verb. A rule's step arrives
    // with `{issueId, stateId}` from a template and must answer `{ok, message}`
    // for the run log; the panel's arrives with a per-issue state key the schema
    // invented and must answer a vocabulary action result. One handler serving
    // both would have to guess which caller it had.
    //
    // The step's declared `id` in `plugin.json` is unchanged (`set_issue_state`
    // and friends) — that is what a saved rule stores, so renaming the handler
    // behind it costs nothing and renaming the id would break every rule.

    stepSetIssueState: (args) => deps.automation.steps.setIssueState(args),
    stepCommentOnIssue: (args) => deps.automation.steps.commentOnIssue(args),
    stepAssignIssue: (args) => deps.automation.steps.assignIssue(args),
    stepCloseIssueOnMerge: (args) => deps.automation.steps.closeIssueOnMerge(args),
    stepStartIssueOnLane: (args) => deps.automation.steps.startIssueOnLane(args),

    /* ── Search ──────────────────────────────────────────────────────────── */

    /** Universal search: this project's Linear issues, by key or by title. */
    searchIssuesProvider: (args) => deps.automation.searchProvider(args),

    /* ── Sockets and the palette ─────────────────────────────────────────── */

    /**
     * Go to the issue list — the palette, the keybinding, the composer button and
     * the CLI all press this.
     *
     * The refresh is fired and NOT awaited: navigation should be instant, and the
     * panel that lands is the one this plugin last published rather than a blank
     * screen behind a network call.
     */
    async openIssues() {
      void ensureIssues();
      return { navigate: { panelId: "issues" } };
    },

    /**
     * The issue picker, from the composer's three-dot menu.
     *
     * Its whole contract is `composer.attach` then `surface.close`, which only
     * the page can perform — and the socket's own `webviewSurfaceId` is what
     * opens that page. This handler is the answer for a client that hosts none,
     * so it navigates to the list rather than pretending a panel can attach a
     * chip.
     *
     * It moved from a `composer-action` bar button to a `composer-menu-item`
     * and the handler did not change: a menu row and a bar button press the
     * same id, and which one the reader sees is the manifest's decision.
     */
    async openIssuePicker() {
      void ensureIssues();
      // `navigate`, and ONLY `navigate`. A `webviewSurfaceId` on the manifest
      // socket opens the page BY ITSELF and never invokes this action, so this
      // handler runs only on a client that hosts no page — and an `openWebview`
      // answer here would be a second open of a surface already up, closing the
      // first. One instruction per client, decided in one place.
      return { navigate: { panelId: "issues" } };
    },

    /**
     * One issue's detail page.
     *
     * The row's `onPress`, a sub-issue row's, the smart-link chip's, the URL
     * matcher's and a bulk bar's tick. One handler for all of them, so the four
     * places an id can ride are read in one order and only one order — and
     * through `issueIdFromRowKey`, because a tick carries the row's COLLECTION
     * key (`flat:000012:<id>`) when the row declared none.
     */
    async openIssue(args) {
      const selection = Array.isArray(args?.selection) ? args.selection : [];
      const raw = args?.issueId ?? args?.key ?? args?.context?.issueId ?? selection[0] ?? null;
      const issueId = raw ? (issueIdFromRowKey(raw) ?? raw) : null;
      if (!issueId) return { navigate: { panelId: "issues" } };
      // A URL matcher hands over the issue KEY from the path, not the id, and a
      // key this project has never listed is not in the collections — so the
      // detail read falls through to Linear rather than showing "not found" for
      // an issue that plainly exists.
      const row = await deps.data.findIssueRow(issueId);
      if (!row) await deps.data.refreshIssue(issueId).catch(() => {});
      const resolved = row ?? (await deps.data.findIssueRow(issueId));
      if (!resolved) return { message: `Linear has no issue called ${issueId}.`, ok: false };
      await publish("issue", { issueId: resolved.id });
      return { navigate: { panelId: "issue", context: { issueId: resolved.id } } };
    },

    /** The issue behind the chat the user is in, or a message saying there is none. */
    async openSessionIssue(args) {
      const link = await issueLinkForContext(args);
      if (!link) return { message: NO_ISSUE_FOR_CHAT, ok: false };
      return await ownActions.openIssue({ issueId: link.issueId });
    },

    /**
     * The issue on the open web.
     *
     * The stored row first, and Linear itself when this project has never
     * listed the issue. `findIssueRow` reads the collections alone, so every
     * issue outside the stored view — a chat attached to a ticket from another
     * team, a badge card handed an id the list never carried, an issue linked
     * before the first catalog read — answered "that issue has no Linear link"
     * about an issue whose link plainly exists. `automation.resolveIssue` is
     * the read that falls through to Linear, and it is the same one every agent
     * tool uses for the same reason.
     */
    async openInLinear(args) {
      const issueId = args?.issueId ?? args?.context?.issueId ?? null;
      if (!issueId) return { message: "That issue has no Linear link.", ok: false };
      let row = await deps.data.findIssueRow(issueId);
      if (!row?.url) {
        // Never fatal: a refusal from Linear is still "no link to open", said
        // in the same sentence rather than as a thrown action.
        row = await deps.automation.resolveIssue(issueId).catch(() => null);
      }
      if (!row?.url) return { message: "That issue has no Linear link.", ok: false };
      return { openUrl: row.url };
    },

    /**
     * Open the issue picker as a picker over whatever the page is drawn in.
     *
     * Pressed by the PAGE and by nothing else, which is what keeps it apart
     * from `openIssuePicker`: that one is named by a socket whose
     * `webviewSurfaceId` already opens the picker, so an `openWebview` there
     * would be a second open of a surface already up. No socket names this one.
     *
     * The chat menu's Issue context card needs it because a card in a 360×420
     * popover has nowhere to draw a list. It asks the host for the picker
     * placement instead, which is the same surface the composer's own menu row
     * opens and the same one that knows how to attach a chip.
     */
    async openIssuePickerSurface(args) {
      void ensureIssues();
      const laneId = typeof args?.laneId === "string" && args.laneId.trim() ? args.laneId.trim() : null;
      return {
        openWebview: {
          surfaceId: "picker",
          placement: "picker",
          // The lane the attach lands on, when the caller knows it. The picker
          // reads it as its `pointer` and attaches there rather than guessing.
          ...(laneId ? { context: { laneId } } : {}),
        },
      };
    },

    /**
     * Comment the chat's progress onto its issue.
     *
     * Reads the transcript through the action layer rather than inventing a
     * summary: `chat.readTranscript` is the gated verb for exactly this, and a
     * plugin that made up a progress note would be posting words the agent never
     * said onto a ticket other people read.
     */
    async commentProgress(args) {
      const sessionId = args?.context?.kind === "session" ? args.context.id : args?.sessionId ?? null;
      if (!sessionId) return { message: "Open this from inside a chat.", ok: false };
      // Resolved from the CHAT, never guessed. This read `rows[0]` when nothing
      // matched — and nothing ever matched, because the socket sends a session
      // context with no `laneId` at all. Every press posted the transcript as a
      // comment on the first Linear-linked lane in the project: a ticket other
      // people read, and not the one the reader was looking at.
      const link = await issueLinkForContext(args);
      if (!link) return { message: NO_ISSUE_FOR_CHAT, ok: false };

      let transcript = [];
      try {
        const result = await deps.sdk.actions.invoke("chat", "readTranscript", { sessionId, limit: 10 });
        transcript = Array.isArray(result) ? result : Array.isArray(result?.entries) ? result.entries : [];
      } catch (error) {
        return { message: failureMessage(error, "Could not read this chat."), ok: false };
      }
      const last = [...transcript].reverse().find((entry) => entry?.role === "assistant");
      const body = typeof last?.text === "string" && last.text.trim()
        ? `Progress from ADE:\n\n${last.text.trim().slice(0, 4_000)}`
        : null;
      if (!body) return { message: "This chat has nothing to report yet.", ok: false };

      try {
        await deps.automation.addComment({ issueId: link.issueId, body });
      } catch (error) {
        return { message: failureMessage(error, "Could not comment on the issue."), ok: false };
      }
      return { message: `Commented on ${link.issueKey ?? "the issue"}.` };
    },

    /* ── The webhook ─────────────────────────────────────────────────────── */

    /**
     * Create this workspace's Linear webhook and store its signing secret.
     *
     * The `automation-trigger-tile`'s `registerAction`, and the whole of what
     * used to be a paste box. `webhookSetup.js` says why the secret is
     * generated here rather than copied out of Linear, and why a hook whose
     * secret this plugin does not hold is rotated rather than adopted.
     *
     * A refusal is an ANSWER, not a throw: the tile draws the sentence beside
     * the button, and a rejected promise there is a red toast with no fix in it.
     */
    async registerWebhook() {
      const setup = deps.webhookSetup;
      if (!setup) return { ok: false, message: "Linear is still starting up." };
      const result = await setup.registerWebhook();
      await publish("settings");
      return result;
    },

    /** Undo it: delete the hook and forget the secret. */
    async unregisterWebhook() {
      const setup = deps.webhookSetup;
      if (!setup) return { ok: false, message: "Linear is still starting up." };
      const result = await setup.unregisterWebhook();
      await publish("settings");
      return result;
    },

    /**
     * The tile's status line: registered, last event, unacked, error.
     *
     * The `statusAction`. It reads rather than writes, so it answers a shape
     * even while the plugin is still starting — a tile drawn against a throw
     * would show an error for a plugin that is merely two seconds old.
     */
    async webhookStatus() {
      const setup = deps.webhookSetup;
      if (!setup) {
        return {
          ok: true,
          registered: false,
          canRegister: false,
          status: "Starting up",
          url: null,
          secretStored: false,
          connected: false,
          webhooksPossible: false,
          lastEvent: null,
          pendingDeliveries: 0,
          error: null,
        };
      }
      return await setup.webhookStatus();
    },

    /* ── CLI ─────────────────────────────────────────────────────────────── */

    /**
     * The `ade linear` word.
     *
     * One action with a `verb` argument rather than nine CLI words, because the
     * manifest's `cli` list registers WORDS and nine of them would put nine
     * Linear entries in `ade --help`. The verbs are the built-in's own
     * (`cli.ts:2689`), so a script written against `ade linear issue ADE-1`
     * keeps working.
     */
    async linear(args) {
      const verb = String(args?.verb ?? args?._?.[0] ?? "issues").trim();
      switch (verb) {
        case "issues":
          return await deps.automation.searchIssues(args ?? {});
        case "issue":
          return await deps.automation.getIssue({ issueId: args?.issueId ?? args?._?.[1] });
        case "comment":
          return await deps.automation.addComment({ issueId: args?.issueId ?? args?._?.[1], body: args?.body });
        case "set-state":
          return await deps.automation.updateIssueState({ issueId: args?.issueId ?? args?._?.[1], stateId: args?.stateId });
        case "states":
          return await deps.automation.listStates(args ?? {});
        case "assign":
          return await deps.automation.assignIssue({ issueId: args?.issueId ?? args?._?.[1], assigneeId: args?.assigneeId });
        case "label":
          return await deps.automation.addLabel({ issueId: args?.issueId ?? args?._?.[1], labelName: args?.labelName });
        case "attach":
          return await deps.flows.linkIssueToLane({ issueId: args?.issueId ?? args?._?.[1], laneId: args?.laneId });
        case "lane":
          return await deps.automation.createLaneForIssue({ issueId: args?.issueId ?? args?._?.[1], baseRef: args?.baseRef });
        case "graphql":
          return await deps.automation.graphql(args ?? {});
        case "status": {
          // The connection alone would report a healthy green on an API-key
          // connection whose automations can never fire, so the CLI says both.
          const connection = await deps.data.refreshConnection();
          const status = await deps.connect.connectStatus().catch(() => ({}));
          return {
            connection,
            clientSource: status.clientSource ?? null,
            webhooksPossible: webhooksReachable(status),
            ...(webhooksReachable(status)
              ? {}
              : {
                note: "Linear does not send webhooks to this connection, so automation triggers will not fire. An API key carries no webhook grant — sign in with Linear to receive events.",
              }),
          };
        }
        case "refresh":
          return await refreshIssues();
        default:
          return {
            error: `Unknown verb "${verb}".`,
            verbs: [
              "issues", "issue", "comment", "set-state", "states", "assign",
              "label", "attach", "lane", "graphql", "status", "refresh",
            ],
          };
      }
    },
  };

  return ownActions;
}

module.exports = { createOwnActions };
