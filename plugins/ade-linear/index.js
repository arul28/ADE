// ade-linear — Linear as an ADE plugin, built out of public parts.
//
// The Linear integration ADE ships today is roughly 5,400 lines of desktop
// renderer, 2,900 lines of iOS and 8,200 lines of main-process service, and it
// reaches every one of those surfaces by being compiled into them. This package
// is the same integration with nothing privileged left in it:
//
//   * the issue browser is a `tab` surface plus a `work-rail-pane`, drawn from
//     a vocabulary panel bound to this plugin's own `issues` collection;
//   * the connection is `authSessions` + `credentialHandoff` — the host opens
//     the browser and owns the `state`, and the token is this plugin's from the
//     moment it exists;
//   * the webhook is a declared `webhookIngress` channel at ADE's relay, and
//     the events arrive as `webhook.received` with an ack;
//   * the lane and agent flows are `lane.create`, `chat.createSession` and
//     `ade.lanes.linkIssue`, which is the seam that makes a tracker plugin a
//     first-class one rather than a viewer;
//   * the nine agent tools, the five automation triggers, the four steps, the
//     search provider and the CLI word are all manifest registrations.
//
// `official: true` buys this package exactly two things: the `builtin: "linear"`
// gate on the pane (which is the extraction's own scaffolding and goes away
// when core does) and the relaxation that lets it claim `linear.app` in a URL
// matcher. Everything else a community author could write.
//
// ## Where the work happens
//
// On the machine that holds the credential, and nowhere else. Every client —
// the phone, the web client, the TUI — draws rows this process already shaped,
// which is what makes the whole integration appear on surfaces the built-in's
// 5,400 lines of renderer never reached.
//
// ## The two halves
//
// `panels.js` and `panelActions.js` own what a panel LOOKS like and what its
// buttons do. This file owns everything else and hands the panel half a `host`
// object at activate. The seam is deliberate: the panel half never calls
// Linear and never touches a collection key, and this half never builds a
// schema.

"use strict";

const { createLinearApi, isMissingTokenError } = require("./linearApi");
const { createData } = require("./data");
const { createFlows, parseGithubRemote } = require("./flows");
const { issueBranchName, issueLaneName } = require("./issueFormat");
const { createConnect } = require("./connect");
const { createAutomation } = require("./automation");
const { createWebhookHandler } = require("./webhook");
const panels = require("./panels");
const panelActions = require("./panelActions");

/** Attempts to publish a panel before giving up until the next action. */
const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;

/**
 * How long an issue read is believed before an action refetches it.
 *
 * The built-in's own in-memory cache is 90 s (`LinearIssueBrowser.tsx:81`).
 * This is shorter because a plugin's refresh is cheaper — it writes rows every
 * client already has, rather than re-rendering a 1,874-line component — and
 * because a webhook usually gets there first anyway.
 */
const ISSUE_CACHE_MS = 30_000;

/**
 * The launch form's two provider pickers.
 *
 * Literal rather than read from ADE: `chat.createSession` validates both and
 * neither is discoverable through an action a plugin may call at agent role.
 * A value ADE later stops accepting is refused at launch with ADE's own
 * message, which is a better failure than a picker that silently offers
 * nothing.
 */
const PERMISSION_MODES = [
  { value: "default", label: "Ask before acting" },
  { value: "accept-edits", label: "Accept edits" },
  { value: "full-auto", label: "Full auto" },
];

const REASONING_EFFORTS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

let sdk = null;
let api = null;
let data = null;
let flows = null;
let connect = null;
let automation = null;
let webhook = null;
let disposed = false;
/** Unsubscribe functions for every event this plugin listens to. */
const subscriptions = [];
/** When the issue rows were last materialized. */
let lastIssueRefreshAt = 0;
/** The handler table `panelActions.bind` answered with, kept for `deactivate`. */
let panelHandlers = null;
/** `owner/repo` for the settings panel's autolink card, or null. */
let githubRepoSlug = null;

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

/* ── Publishing ──────────────────────────────────────────────────────────── */

/**
 * Replace a panel's schema, retrying while no project is attached.
 *
 * Panel writes are project-scoped and the plugin host is machine-scoped, so at
 * cold start this can run before any project is open. Letting it throw out of
 * `activate` would read as a crash and start the restart backoff.
 */
async function publishSchema(panelId, schema, attempt = 1) {
  if (!sdk || disposed) return;
  try {
    await sdk.panels.update(panelId, schema);
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      log("warn", `Could not publish the ${panelId} panel: ${error?.message ?? error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    await publishSchema(panelId, schema, attempt + 1);
  }
}

/**
 * Build and publish one panel by id.
 *
 * The panel half decides what the schema IS; this decides when it is written
 * and what it is written FROM. Each builder takes a per-panel view rather than
 * the whole model — an issue detail wants one issue and its thread, and handing
 * it the workspace would make every publish carry 250 rows the schema cannot
 * draw.
 */
async function publish(panelId, context = null) {
  if (!sdk || disposed) return;
  let view;
  try {
    view = await viewFor(panelId, context);
  } catch (error) {
    log("warn", `Could not read the ${panelId} panel's data: ${error?.message ?? error}`);
    return;
  }
  let schema;
  try {
    schema = panels.build(panelId, view, context);
  } catch (error) {
    log("warn", `Could not build the ${panelId} panel: ${error?.message ?? error}`);
    return;
  }
  if (!schema) return;
  await publishSchema(panelId, schema);
}

/** The snapshot every action reads. Never handed to a builder unshaped. */
function model() {
  return data
    ? data.currentModel()
    : { connection: null, counts: { issues: 0, teams: 0 }, lanes: [], models: [], groups: [], autolinks: [] };
}

/** "4 minutes ago", for the list's footer. Absent rather than "never". */
function ago(iso) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 45) return "just now";
  if (seconds < 5_400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * The view one panel is drawn from.
 *
 * Four shapes, because four panels answer four questions. Keeping the mapping
 * here rather than in the builders is what lets the panel half stay a pure
 * function of its input — it never reads a collection, and it never has to know
 * that `groups` is derived while `issue` is a stored row.
 */
async function viewFor(panelId, context) {
  const snapshot = model();
  const connection = snapshot.connection;

  if (panelId === "main") return {};

  if (panelId === "issues") {
    const filters = snapshot.filters ?? {};
    return {
      state: snapshot.error ? "error" : (snapshot.counts.issues === 0 ? "empty" : "list"),
      error: snapshot.error,
      groups: snapshot.groups ?? [],
      query: filters.text || null,
      title: "Linear",
      statePreset: filters.stateTab,
      sort: filters.sort,
      view: filters.view ?? "grouped",
      viewerId: connection?.viewerId ?? null,
      assignedToMe: Boolean(filters.assigneeId && filters.assigneeId === connection?.viewerId),
      hasProjects: filters.hasProjects === true,
      hasPeople: filters.hasPeople === true,
      hasTeams: (snapshot.counts.teams ?? 0) > 1,
      filtersActive: Boolean(filters.projectId || filters.assigneeId || filters.priority || filters.stateTab !== "all"),
      workspace: connection?.organizationName ?? null,
      age: ago(snapshot.updatedAt),
    };
  }

  if (panelId === "issue") {
    const issueId = context?.issueId ?? null;
    const issue = issueId ? await data.issueRow(issueId) : null;
    if (!issue) {
      return { state: "detail", issue: null, error: snapshot.error ?? null };
    }
    const rows = await sdk.collections
      .list("comments", { keyPrefix: `comment:${issue.id}:`, limit: 60 })
      .catch(() => []);
    return {
      state: "detail",
      issue,
      error: null,
      subIssues: issue.subIssues ?? [],
      comments: rows.map((row) => row.value).filter(Boolean),
      commentsState: "loaded",
      // The plugin stores at most `MAX_COMMENTS_PER_ISSUE`; a thread longer
      // than that has earlier comments only Linear can show.
      hasEarlierComments: rows.length >= 50,
    };
  }

  if (panelId === "launch") {
    const issueId = context?.issueId ?? null;
    const issue = issueId ? await data.issueRow(issueId) : null;
    if (!issue) return { state: "form", issue: null, error: "That issue is not in this project's Linear view." };
    return {
      state: "form",
      issue,
      // The models this project can actually run. An empty list draws the form
      // without the picker and the provider takes its own default, which is the
      // same launch one tap later rather than a form that cannot submit.
      models: (snapshot.models ?? []).map((entry) => ({ id: entry.value, label: entry.label })),
      permissionModes: PERMISSION_MODES,
      reasoningEfforts: REASONING_EFFORTS,
      laneOnly: false,
      sessionType: "chat",
      // The two names derived from the issue, shown before the reader commits:
      // the branch is the one Linear matches on, so seeing it is the difference
      // between trusting the link and hoping for it.
      laneName: issueLaneName(issue),
      branchName: issueBranchName(issue),
      kickoff: flows.defaultKickoff(issue),
      fastModeSupported: false,
      error: null,
      unavailable: snapshot.connection?.connected ? null : "Connect Linear first.",
    };
  }

  if (panelId === "settings") {
    const settings = await sdk.config.get().catch(() => ({}));
    const status = await connect.connectStatus().catch(() => ({}));
    return {
      state: connection?.connected ? "connected" : "disconnected",
      error: connection?.lastError ?? null,
      connection,
      // "offered" is the one value the panel draws the adopt button for, so it
      // is set only while the handoff has genuinely not been answered.
      handoffStatus: status.canHandoff ? "offered" : (status.handoffStatus ?? null),
      settings,
      teams: await data.teams().catch(() => []),
      showAutolinks: Boolean(connection?.organizationUrlKey),
      autolinks: snapshot.autolinks ?? [],
      githubRepo: githubRepoSlug,
      ingress: connection?.webhookUrl ? { url: connection.webhookUrl } : null,
      oauthBlockedReason: status.oauthBlockedReason ?? null,
    };
  }

  return snapshot;
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/**
 * The whole issue read, then the two panels that show it.
 *
 * One function rather than three, because every entry point wants all of it —
 * the refresh gesture, the CLI word, the webhook that changed one issue, the
 * `activate` with nothing on screen — and a caller that refreshed the rows and
 * forgot the panel would leave the reader looking at a stale screen with fresh
 * data behind it.
 */
async function refreshIssues(options = {}) {
  if (!sdk || disposed) return { state: "loading" };
  const result = await data.refreshIssues(options);
  lastIssueRefreshAt = Date.now();
  await publish("issues");
  await publish("main");
  return result;
}

/** The rows, refreshed when they are older than the cache window. */
async function ensureIssues() {
  if (Date.now() - lastIssueRefreshAt > ISSUE_CACHE_MS) await refreshIssues();
}

/**
 * The chat models this project offers, for the launch form's picker.
 *
 * Best-effort: a project with no models configured draws the form without the
 * picker, and the provider picks its own default — which is the same launch one
 * tap later, not a failure.
 */
async function loadModels() {
  try {
    const listed = await sdk.actions.invoke("chat", "getAvailableModels", {});
    const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.models) ? listed.models : [];
    data.setModels(rows
      .map((entry) => (typeof entry === "string"
        ? { value: entry, label: entry }
        : { value: entry?.id ?? entry?.value ?? null, label: entry?.label ?? entry?.name ?? entry?.id ?? null }))
      .filter((entry) => entry.value && entry.label)
      .slice(0, 50));
  } catch (error) {
    log("debug", `Could not read the chat models: ${error?.message ?? error}`);
  }
}

/* ── Lane contributions ──────────────────────────────────────────────────── */

/**
 * The Linear badge on every lane that carries an issue.
 *
 * Published as a `row-badge` and a `graph-node` contribution, which is how a
 * lane row on the desktop, on the phone and in the graph all draw the same
 * thing without any of them knowing what Linear is. Two socket KINDS on one
 * surface, so each publish names its `id` — a row keyed only by kind would let
 * the second publish replace the first.
 */
async function publishLaneBadges() {
  if (!sdk || disposed) return;
  const { rows } = await data.laneIndex();
  const byLane = new Map();
  for (const row of rows) {
    if (!byLane.has(row.laneId)) byLane.set(row.laneId, []);
    byLane.get(row.laneId).push(row);
  }
  for (const [laneId, links] of byLane) {
    const first = links[0];
    const stored = await data.issueRow(first.issueId);
    const payload = {
      id: "lane-issue",
      label: first.issueKey ?? stored?.identifier ?? "Linear",
      tone: stored?.badgeTone ?? "neutral",
      tooltip: stored?.title ?? null,
      url: stored?.url ?? null,
      count: links.length,
    };
    await sdk.contributions.publish("lane", laneId, "row-badge", payload).catch(() => {});
    await sdk.contributions.publish("lane", laneId, "graph-node", { ...payload, id: "graph-issue" }).catch(() => {});
  }
}

/* ── The adapter the panel half reaches ──────────────────────────────────── */

/**
 * The host object `panelActions.bind` is given.
 *
 * Every path in `panelActions.HOST_CAPABILITIES` is answered here, and the
 * argument shapes are the PANEL half's — positional ids where this half takes
 * option objects. A missing path is not an error over there (the reader gets
 * "that needs the plugin's data layer"), which is exactly why every one of them
 * is written out: a silently absent verb is a button that does nothing.
 */
function buildPanelHost() {
  return {
    publish,
    model,

    data: {
      /** The list's own refresh, and the "something changed" redraw. */
      reload: async () => await refreshIssues(),

      /**
       * A filter control moved.
       *
       * `{reset: true}` clears back to the defaults; anything else is merged.
       * Both re-read Linear, because the state preset changes which GROUPS
       * exist and a predicate cannot remove a section.
       */
      setFilters: async (patch) => {
        const next = patch?.reset === true
          ? await (async () => {
            await data.writeFilters(data.defaultFilters());
            return data.defaultFilters();
          })()
          : await data.updateFilters(patch ?? {});
        await refreshIssues({ filters: next });
        return next;
      },

      /** The search box. An empty string is "clear", not "match nothing". */
      search: async (text) => {
        const next = await data.updateFilters({ text: typeof text === "string" ? text : "" });
        await refreshIssues({ filters: next });
        return next;
      },

      loadIssue: async (issueId) => {
        const result = await data.refreshIssue(issueId);
        await publish("issue", { issueId });
        if (!result.ok) throw new Error(result.error);
        return result.issue;
      },

      loadComments: async (issueId) => {
        const result = await data.refreshComments(issueId);
        await publish("issue", { issueId });
        return result;
      },
    },

    api: {
      setIssueState: async (issueId, stateId) => {
        await automation.updateIssueState({ issueId, stateId });
        await publish("issue", { issueId });
        await publish("issues");
      },
      setIssuePriority: async (issueId, priority) => {
        const row = await automation.resolveIssue(issueId);
        await api.updateIssuePriority(row.id, Number(priority));
        await data.refreshIssue(row.id, { comments: false });
        await publish("issue", { issueId: row.id });
        await publish("issues");
      },
      assignIssue: async (issueId, assigneeId) => {
        await automation.assignIssue({ issueId, assigneeId });
        await publish("issue", { issueId });
        await publish("issues");
      },
      createComment: async (issueId, body) => await automation.addComment({ issueId, body }),
    },

    flows: {
      /**
       * The two launch verbs.
       *
       * The panel sends `(issueId, args)` where `args` is the whole action
       * frame — a lane id when the reader pressed from inside one, and the
       * launch form's values when they came through the launch panel.
       */
      createLaneFromIssue: async (issueId, args) => {
        const result = await flows.createLaneFromIssue({
          issueId,
          ...(args?.baseRef ? { baseRef: args.baseRef } : {}),
        });
        if (!result.ok) throw new Error(result.message);
        await refreshIssues();
        return result;
      },

      spawnAgentOnIssue: async (issueId, args) => {
        const lane = await flows.createLaneFromIssue({
          issueId,
          ...(args?.baseRef ? { baseRef: args.baseRef } : {}),
        });
        if (!lane.ok) throw new Error(lane.message);
        const agent = await flows.spawnAgentOnIssue({
          issueId,
          laneId: lane.laneId,
          ...(args?.prompt ? { prompt: args.prompt } : {}),
          ...(args?.sessionType ? { sessionType: args.sessionType } : {}),
          ...(args?.provider ? { provider: args.provider } : {}),
          ...(args?.model ? { model: args.model } : {}),
          ...(args?.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
          ...(args?.permissionMode ? { permissionMode: args.permissionMode } : {}),
          ...(typeof args?.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
        });
        // The LANE exists either way. Reporting only the agent's failure would
        // send the reader looking for work that has a branch waiting for it.
        if (!agent.ok) throw new Error(`Opened the lane, but could not start the agent: ${agent.message}`);
        await refreshIssues();
        return agent;
      },

      /** The bulk bar: attach several issues to the lane the reader is in. */
      linkIssueToLane: async (issueIds) => {
        const ids = Array.isArray(issueIds) ? issueIds : [issueIds];
        const lanes = await sdk.lanes.list().catch(() => []);
        const laneId = lanes[0]?.id ?? null;
        if (!laneId) throw new Error("Open a lane first.");
        for (const issueId of ids) {
          const result = await flows.linkIssueToLane({ issueId, laneId });
          if (!result.ok) throw new Error(result.message);
        }
        await refreshIssues();
        return { linked: ids.length };
      },

      /**
       * Draw the launch form for one issue.
       *
       * Its presence is what turns the two one-tap launch buttons into a form:
       * `panelActions.openLaunch` treats a missing `flows.openLaunch` as "this
       * build has no launch panel" and launches with the defaults instead. So
       * this and the manifest's `launch` panel go together, and neither is
       * useful without the other.
       */
      openLaunch: async (issueId) => {
        // The models are read lazily rather than at activate, because a project
        // that never opens the form should not pay for the round trip.
        if ((model().models ?? []).length === 0) await loadModels();
        await publish("launch", { issueId });
        return { issueId };
      },

      connectOAuth: async () => {
        const result = await connect.begin();
        if (!result.ok) throw new Error(result.message);
        // Returned verbatim so the host can fill in the live URL on the way to
        // whichever client the user is on.
        return { authSession: result.authSession };
      },

      connectApiKey: async (key) => {
        const result = await connect.saveApiKey(key);
        if (!result.ok) throw new Error(result.message);
        await refreshCatalogAndIssues();
        return result;
      },

      adoptHandoff: async () => {
        const result = await connect.requestHandoff();
        if (result.status === "error") throw new Error(result.message);
        // `false` is what the panel words as "ADE kept the connection" — a
        // decline and an empty store are both "nothing moved", and neither is
        // an error.
        if (result.status !== "accepted") return false;
        await refreshCatalogAndIssues();
        return true;
      },

      disconnect: async () => {
        const result = await connect.disconnect();
        await publish("issues");
        return result;
      },

      applySettings: async (values) => {
        const writable = {};
        for (const [key, value] of Object.entries(values ?? {})) {
          if (key === "moveToDoneOnMerge" || key === "moveToStartedOnLaunch") writable[key] = value === true;
          else if (key === "defaultTeamKey") writable[key] = typeof value === "string" ? value : null;
        }
        if (Object.keys(writable).length === 0) return {};
        return await sdk.config.set(writable);
      },

      createAutolink: async (prefix) => {
        const result = await flows.createAutolink({ teamKey: String(prefix ?? "").replace(/-$/, "") });
        if (!result.ok) throw new Error(result.message);
        return result;
      },
    },

    sdk: {
      clipboard: { write: async (text) => await sdk.clipboard.write(text) },
    },
  };
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;

  api = createLinearApi({ secrets: sdk.secrets, log: (level, message) => log(level, message) });
  data = createData({ sdk, api, log: (level, message) => log(level, message) });
  flows = createFlows({ sdk, api, data, log: (level, message) => log(level, message) });
  connect = createConnect({ sdk, api, data, log: (level, message) => log(level, message) });
  automation = createAutomation({ api, data, flows, log: (level, message) => log(level, message) });
  webhook = createWebhookHandler({ sdk, data, log: (level, message) => log(level, message) });

  // The panel half is given everything it needs and nothing more. It reaches
  // this object by DOTTED PATH (`panelActions.HOST_CAPABILITIES`) and treats a
  // missing branch as "this host cannot do that yet" rather than as a crash —
  // which is why the adapter below is written out in full rather than passing
  // `data` and `flows` straight through. The argument shapes are the panel
  // half's, not this half's, and translating them here is the whole job of an
  // adapter: the two halves are allowed to disagree about what a verb's
  // arguments look like, and are not allowed to disagree silently.
  panelHandlers = panelActions.bind(buildPanelHost());
  Object.assign(exports.actions, panelHandlers, ownActions);

  // A sign-in the host completed. Subscribed BEFORE anything can begin one, as
  // the SDK requires — a `beginSession` whose listener is not yet attached
  // would lose its own result.
  subscriptions.push(sdk.events.on("auth.completed", (payload) => {
    connect.complete(payload)
      .then(async (result) => {
        if (result?.ok) {
          await refreshCatalogAndIssues();
        }
        await publish("settings");
      })
      .catch((error) => log("warn", `Could not finish the Linear sign-in: ${error?.message ?? error}`));
  }));

  // A relay delivery is the only signal an issue nobody is watching ever gets.
  subscriptions.push(sdk.events.on("webhook.received", (payload) => {
    webhook.handle(payload)
      .then(async (result) => {
        // A duplicate changed nothing, so it costs no publish.
        if (result?.duplicate || result?.unreadable || result?.ignored) return;
        await publish("issues");
        await publishLaneBadges();
      })
      .catch((error) => log("warn", `Could not handle a Linear webhook: ${error?.message ?? error}`));
  }));

  // A lane that appeared or left changes which issues carry a `hasLane` badge.
  subscriptions.push(sdk.events.on("lane.changed", () => {
    void refreshIssues().then(() => publishLaneBadges()).catch(() => {});
  }));

  // The merged-PR transition. `pr.changed` is a coalesced hint with ids and no
  // previous state, so the merge is derived by reading the PRs back — see
  // `flows.closeIssueOnMerge` for why that is not the same trigger core has.
  subscriptions.push(sdk.events.on("pr.changed", (payload) => {
    void (async () => {
      try {
        const laneIds = await flows.mergedLanesFromPrIds(payload?.ids ?? []);
        if (laneIds.length === 0) return;
        const result = await flows.closeIssueOnMerge({ laneIds });
        if (result.moved > 0) await refreshIssues();
      } catch (error) {
        log("warn", `Could not act on a merged pull request: ${error?.message ?? error}`);
      }
    })();
  }));

  await publish("main");

  // The release-day handoff. Asked once per install by the host; a `declined`
  // is a normal state and not an error, so nothing branches on it here beyond
  // letting the settings panel say so.
  await connect.requestHandoff().catch(() => {});

  await refreshCatalogAndIssues().catch((error) => {
    log("warn", `The first Linear read failed: ${error?.message ?? error}`);
  });
  void loadModels();
};

/**
 * `owner/repo` for the settings panel's autolink card.
 *
 * Read once per full refresh rather than per publish: the origin remote does
 * not change while ADE is open, and the settings panel is republished on every
 * connection change.
 */
async function readGithubRepo() {
  try {
    const result = await sdk.actions.invoke("git", "getOriginRemote", {});
    const remote = typeof result === "string" ? result : result?.url ?? result?.remote ?? null;
    const repo = parseGithubRemote(remote);
    githubRepoSlug = repo ? `${repo.owner}/${repo.name}` : null;
  } catch {
    // No git, no project, or no origin. The card says so; it is not a failure.
    githubRepoSlug = null;
  }
}

/**
 * The connection, then the near-static catalog, then the issues.
 *
 * In that order and not in parallel: the catalog read tells the connection
 * whether the credential actually works, and the issue read is the expensive
 * one that must not be spent on a credential Linear is going to refuse.
 */
async function refreshCatalogAndIssues() {
  const connection = await data.refreshConnection();
  await publish("settings");
  if (!connection?.connected) {
    await publish("issues");
    await publish("main");
    return { state: "no-token" };
  }
  await data.refreshCatalog(null).catch(() => {});
  await data.buildAutolinks(connection.organizationUrlKey ?? null).catch(() => {});
  await readGithubRepo();
  const result = await refreshIssues();
  await publishLaneBadges().catch(() => {});
  return result;
}

exports.deactivate = async () => {
  disposed = true;
  while (subscriptions.length) {
    try {
      subscriptions.pop()?.();
    } catch { /* an unsubscribe that throws is not worth a crash on the way out */ }
  }
  await connect?.cancel().catch(() => {});
  sdk = null;
  api = null;
  data = null;
  flows = null;
  connect = null;
  automation = null;
  webhook = null;
};

/* ── Actions ─────────────────────────────────────────────────────────────── */

/** One sentence for whatever Linear refused, worded for a banner. */
function failureMessage(error, fallback) {
  if (isMissingTokenError(error)) return "Connect Linear in Settings → Linear.";
  return error?.message ?? fallback;
}

/**
 * The action table.
 *
 * `panelActions.actions` is spread in FIRST so the three refresh ids below win:
 * they are named by `plugin.json`'s `refreshAction` fields and by the panel
 * schemas' Retry buttons, and the data half is what performs them. Everything
 * else a panel dispatches belongs to the panel half and is taken from it
 * unchanged.
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
    const result = await data.refreshIssue(issueId);
    await publish("issue", { issueId });
    if (!result.ok) return { message: result.error, ok: false };
    return { message: null };
  },

  /** The settings section's refresh gesture. */
  async refreshConnection() {
    const connection = await data.refreshConnection();
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

  getIssueTool: (args) => automation.getIssue(args),
  searchIssuesTool: (args) => automation.searchIssues(args),
  addCommentTool: (args) => automation.addComment(args),
  updateIssueStateTool: (args) => automation.updateIssueState(args),
  listStatesTool: (args) => automation.listStates(args),
  assignIssueTool: (args) => automation.assignIssue(args),
  addLabelTool: (args) => automation.addLabel(args),
  createLaneForIssueTool: (args) => automation.createLaneForIssue(args),
  graphqlTool: (args) => automation.graphql(args),

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

  stepSetIssueState: (args) => automation.steps.setIssueState(args),
  stepCommentOnIssue: (args) => automation.steps.commentOnIssue(args),
  stepAssignIssue: (args) => automation.steps.assignIssue(args),
  stepCloseIssueOnMerge: (args) => automation.steps.closeIssueOnMerge(args),

  /* ── Search ──────────────────────────────────────────────────────────── */

  /** Universal search: this project's Linear issues, by key or by title. */
  searchIssuesProvider: (args) => automation.searchProvider(args),

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

  /** One issue's detail page. The row's `onPress` and the smart-link chip's. */
  async openIssue(args) {
    const issueId = args?.issueId ?? args?.context?.issueId ?? null;
    if (!issueId) return { navigate: { panelId: "issues" } };
    // A URL matcher hands over the issue KEY from the path, not the id, and a
    // key this project has never listed is not in the collections — so the
    // detail read falls through to Linear rather than showing "not found" for
    // an issue that plainly exists.
    const row = await data.findIssueRow(issueId);
    if (!row) await data.refreshIssue(issueId).catch(() => {});
    const resolved = row ?? (await data.findIssueRow(issueId));
    if (!resolved) return { message: `Linear has no issue called ${issueId}.`, ok: false };
    await publish("issue", { issueId: resolved.id });
    return { navigate: { panelId: "issue", context: { issueId: resolved.id } } };
  },

  /** The issue behind the chat the user is in, or a message saying there is none. */
  async openSessionIssue(args) {
    const laneId = args?.context?.kind === "lane"
      ? args.context.id
      : args?.laneId ?? (args?.context?.kind === "composer" ? args.context.laneId : null);
    const { rows } = await data.laneIndex();
    const link = rows.find((row) => row.laneId === laneId) ?? null;
    if (!link) return { message: "This lane has no Linear issue attached.", ok: false };
    return await ownActions.openIssue({ issueId: link.issueId });
  },

  /** The issue on the open web. */
  async openInLinear(args) {
    const issueId = args?.issueId ?? args?.context?.issueId ?? null;
    const row = issueId ? await data.findIssueRow(issueId) : null;
    if (!row?.url) return { message: "That issue has no Linear link.", ok: false };
    return { openUrl: row.url };
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
    const laneId = args?.laneId ?? null;
    const { rows } = await data.laneIndex();
    const link = rows.find((row) => row.laneId === laneId) ?? rows[0] ?? null;
    if (!link) return { message: "This lane has no Linear issue attached.", ok: false };

    let transcript = [];
    try {
      const result = await sdk.actions.invoke("chat", "readTranscript", { sessionId, limit: 10 });
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
      await automation.addComment({ issueId: link.issueId, body });
    } catch (error) {
      return { message: failureMessage(error, "Could not comment on the issue."), ok: false };
    }
    return { message: `Commented on ${link.issueKey ?? "the issue"}.` };
  },

  /**
   * Store the signing secret Linear shows when the webhook is created.
   *
   * The manifest does NOT declare `verify` today, so this secret is not yet
   * checked — see the gap list. It is written now because the order matters:
   * a channel that declares `verify` and cannot find its secret FAILS CLOSED
   * (`pluginWebhookIngressService.ts:429`), so declaring it before users have a
   * way to store the secret would silently drop every delivery. With this
   * action in place, turning verification on is a one-line manifest change.
   */
  async saveWebhookSecret(args) {
    const secret = typeof args?.secret === "string" ? args.secret.trim() : "";
    if (!secret) return { message: "Paste the signing secret Linear showed you.", ok: false };
    await sdk.secrets.set("LINEAR_WEBHOOK_SECRET", secret);
    await publish("settings");
    return { message: "Saved the Linear webhook signing secret." };
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
        return await automation.searchIssues(args ?? {});
      case "issue":
        return await automation.getIssue({ issueId: args?.issueId ?? args?._?.[1] });
      case "comment":
        return await automation.addComment({ issueId: args?.issueId ?? args?._?.[1], body: args?.body });
      case "set-state":
        return await automation.updateIssueState({ issueId: args?.issueId ?? args?._?.[1], stateId: args?.stateId });
      case "states":
        return await automation.listStates(args ?? {});
      case "assign":
        return await automation.assignIssue({ issueId: args?.issueId ?? args?._?.[1], assigneeId: args?.assigneeId });
      case "label":
        return await automation.addLabel({ issueId: args?.issueId ?? args?._?.[1], labelName: args?.labelName });
      case "attach":
        return await flows.linkIssueToLane({ issueId: args?.issueId ?? args?._?.[1], laneId: args?.laneId });
      case "lane":
        return await automation.createLaneForIssue({ issueId: args?.issueId ?? args?._?.[1], baseRef: args?.baseRef });
      case "graphql":
        return await automation.graphql(args ?? {});
      case "status":
        return { connection: await data.refreshConnection() };
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

/**
 * The action table the host dispatches into.
 *
 * Seeded at LOAD with this half's own handlers, so every id the manifest
 * declares — the nine tools, the four steps, the search provider, the CLI word
 * — resolves before `activate` has run. The panel half's handlers need a bound
 * host and are merged in at activate; `ownActions` is re-applied after them so
 * the four ids both halves name (`setIssueState`, `commentOnIssue`,
 * `assignIssue`, and the three refreshes) stay this half's.
 */
exports.actions = { ...ownActions };

// Exported for the host-level install test and for `test/`, which drive the
// lifecycle without a running daemon.
exports.__internals = {
  ISSUE_CACHE_MS,
  publish,
  refreshCatalogAndIssues,
  refreshIssues,
};
